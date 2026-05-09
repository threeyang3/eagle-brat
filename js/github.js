// github.js - GitHub API interaction module for Eagle BRAT

const GitHub = (() => {
  const https = require('https');

  const API_BASE = 'https://api.github.com';
  const USER_AGENT = 'Eagle-BRAT-Plugin/1.0';

  function request(url, token) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'application/vnd.github.v3+json',
      };
      if (token) {
        headers['Authorization'] = `token ${token}`;
      }

      const req = https.get(url, { headers }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          const rateLimit = {
            limit: parseInt(res.headers['x-ratelimit-limit'] || '0'),
            remaining: parseInt(res.headers['x-ratelimit-remaining'] || '0'),
            reset: parseInt(res.headers['x-ratelimit-reset'] || '0'),
          };

          if (res.statusCode === 403 && rateLimit.remaining === 0) {
            const resetDate = new Date(rateLimit.reset * 1000);
            reject({
              type: 'RATE_LIMIT',
              message: `GitHub API rate limit exceeded. Resets at ${resetDate.toLocaleTimeString()}.`,
              rateLimit,
            });
            return;
          }

          if (res.statusCode === 404) {
            reject({ type: 'NOT_FOUND', message: 'Repository or resource not found.' });
            return;
          }

          if (res.statusCode !== 200) {
            reject({
              type: 'API_ERROR',
              message: `GitHub API error: ${res.statusCode}`,
              status: res.statusCode,
              rateLimit,
            });
            return;
          }

          try {
            resolve({ data: JSON.parse(body), rateLimit });
          } catch (e) {
            reject({ type: 'PARSE_ERROR', message: 'Failed to parse GitHub API response.' });
          }
        });
      });

      req.on('error', (e) => {
        reject({ type: 'NETWORK_ERROR', message: `Network error: ${e.message}` });
      });

      req.setTimeout(15000, () => {
        req.destroy();
        reject({ type: 'TIMEOUT', message: 'Request timed out.' });
      });
    });
  }

  function downloadFile(url, token) {
    return new Promise((resolve, reject) => {
      const headers = {
        'User-Agent': USER_AGENT,
      };
      if (token) {
        headers['Authorization'] = `token ${token}`;
      }

      const doRequest = (requestUrl) => {
        const protocol = requestUrl.startsWith('https') ? https : require('http');
        const req = protocol.get(requestUrl, { headers }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            doRequest(res.headers.location);
            return;
          }

          if (res.statusCode !== 200) {
            reject({ type: 'DOWNLOAD_ERROR', message: `Download failed: ${res.statusCode}` });
            return;
          }

          const chunks = [];
          res.on('data', (chunk) => { chunks.push(chunk); });
          res.on('end', () => {
            resolve(Buffer.concat(chunks));
          });
        });

        req.on('error', (e) => {
          reject({ type: 'NETWORK_ERROR', message: `Download error: ${e.message}` });
        });

        req.setTimeout(30000, () => {
          req.destroy();
          reject({ type: 'TIMEOUT', message: 'Download timed out.' });
        });
      };

      doRequest(url);
    });
  }

  // Scrub repository URL to owner/repo format
  function scrubRepo(input) {
    let repo = input.trim();
    repo = repo.replace(/^https?:\/\/github\.com\//i, '');
    repo = repo.replace(/\.git$/, '');
    repo = repo.replace(/\/+$/, '');
    return repo;
  }

  function isValidRepoFormat(repo) {
    return /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo);
  }

  async function fetchReleases(repo, token, includePrereleases) {
    const cleanRepo = scrubRepo(repo);
    const url = `${API_BASE}/repos/${cleanRepo}/releases?per_page=100`;
    const { data, rateLimit } = await request(url, token);

    let releases = data;
    if (!includePrereleases) {
      releases = releases.filter(r => !r.prerelease);
    }

    return {
      releases: releases.map(r => ({
        tagName: r.tag_name,
        name: r.name || r.tag_name,
        body: r.body || '',
        prerelease: r.prerelease,
        publishedAt: r.published_at,
        assets: r.assets.map(a => ({
          name: a.name,
          url: a.url,
          browserDownloadUrl: a.browser_download_url,
          size: a.size,
        })),
      })),
      rateLimit,
    };
  }

  async function fetchRepoInfo(repo, token) {
    const cleanRepo = scrubRepo(repo);
    const url = `${API_BASE}/repos/${cleanRepo}`;
    const { data, rateLimit } = await request(url, token);

    return {
      info: {
        fullName: data.full_name,
        name: data.name,
        description: data.description || '',
        owner: data.owner.login,
        stars: data.stargazers_count,
        updatedAt: data.updated_at,
        defaultBranch: data.default_branch,
      },
      rateLimit,
    };
  }

  async function validateEaglePlugin(repo, version, token) {
    const cleanRepo = scrubRepo(repo);
    let release;

    try {
      if (version) {
        const url = `${API_BASE}/repos/${cleanRepo}/releases/tags/${version}`;
        const { data } = await request(url, token);
        release = data;
      } else {
        const url = `${API_BASE}/repos/${cleanRepo}/releases?per_page=1`;
        const { data } = await request(url, token);
        release = data[0];
      }
    } catch (e) {
      return { valid: false, error: e.message };
    }

    if (!release) {
      return { valid: false, error: 'No releases found for this repository.' };
    }

    const assets = release.assets || [];
    const hasManifest = assets.some(a => a.name === 'manifest.json');
    const hasEaglePlugin = assets.some(a => a.name.endsWith('.eagleplugin'));

    if (!hasManifest && !hasEaglePlugin) {
      // Try to check if manifest.json exists in the repo root via raw content
      try {
        const rawUrl = `https://raw.githubusercontent.com/${cleanRepo}/${release.tag_name}/manifest.json`;
        const manifestContent = await downloadFile(rawUrl, token);
        const manifest = JSON.parse(manifestContent.toString('utf-8'));
        if (manifest.id && manifest.name) {
          return {
            valid: true,
            manifest,
            release: {
              tagName: release.tag_name,
              name: release.name || release.tag_name,
              assets: assets.map(a => ({
                name: a.name,
                browserDownloadUrl: a.browser_download_url,
                size: a.size,
              })),
            },
            installMethod: 'raw', // Download files from raw GitHub
          };
        }
      } catch (e) {
        // Not found via raw content either
      }

      return {
        valid: false,
        error: 'This repository does not appear to be an Eagle plugin. No manifest.json found in release assets or repository root.',
      };
    }

    // Get manifest from release assets or raw content
    let manifest = null;
    if (hasManifest) {
      try {
        const manifestAsset = assets.find(a => a.name === 'manifest.json');
        const content = await downloadFile(manifestAsset.browser_download_url, token);
        manifest = JSON.parse(content.toString('utf-8'));
      } catch (e) {
        // Try raw
      }
    }

    if (!manifest) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${cleanRepo}/${release.tag_name}/manifest.json`;
        const content = await downloadFile(rawUrl, token);
        manifest = JSON.parse(content.toString('utf-8'));
      } catch (e) {
        return { valid: false, error: 'Failed to read manifest.json from repository.' };
      }
    }

    return {
      valid: true,
      manifest,
      release: {
        tagName: release.tag_name,
        name: release.name || release.tag_name,
        assets: assets.map(a => ({
          name: a.name,
          browserDownloadUrl: a.browser_download_url,
          size: a.size,
        })),
      },
      installMethod: hasEaglePlugin ? 'eagleplugin' : hasManifest ? 'assets' : 'raw',
    };
  }

  async function getRateLimit(token) {
    const url = `${API_BASE}/rate_limit`;
    const { data } = await request(url, token);
    return data.rate;
  }

  return {
    scrubRepo,
    isValidRepoFormat,
    fetchReleases,
    fetchRepoInfo,
    validateEaglePlugin,
    downloadFile,
    getRateLimit,
  };
})();
