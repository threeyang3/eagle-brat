// installer.js - Plugin install/uninstall/update logic for Eagle BRAT

const Installer = (() => {
  const fs = require('fs');
  const pathModule = require('path');
  const { execSync } = require('child_process');

  let pluginsRoot = '';

  function init(pluginPath) {
    pluginsRoot = pathModule.dirname(pluginPath);
  }

  function getPluginsRoot() {
    return pluginsRoot;
  }

  // Sanitize a string to be a valid directory name
  function sanitizeDirName(name) {
    return name.replace(/[<>:"/\\|?*\s]/g, '_').replace(/_+/g, '_');
  }

  // Recursively remove a directory
  function removeDir(dirPath) {
    if (fs.existsSync(dirPath)) {
      fs.readdirSync(dirPath).forEach((file) => {
        const curPath = pathModule.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          removeDir(curPath);
        } else {
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(dirPath);
    }
  }

  // Write files from a flat list (name -> content) into a directory
  function writeFiles(targetDir, files) {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    for (const [fileName, content] of Object.entries(files)) {
      const filePath = pathModule.join(targetDir, fileName);
      const dir = pathModule.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content);
    }
  }

  // Install plugin from GitHub release
  async function installPlugin(repo, version, token) {
    const cleanRepo = GitHub.scrubRepo(repo);

    // Validate the repo
    const validation = await GitHub.validateEaglePlugin(cleanRepo, version, token);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const manifest = validation.manifest;
    const pluginId = manifest.id;
    const pluginName = manifest.name;
    const pluginVersion = manifest.version || validation.release.tagName;
    const targetDir = pathModule.join(pluginsRoot, sanitizeDirName(pluginId));

    // If already installed, remove old version first
    if (fs.existsSync(targetDir)) {
      removeDir(targetDir);
    }

    if (validation.installMethod === 'eagleplugin') {
      // Download .eagleplugin file and extract
      const eaglePluginAsset = validation.release.assets.find(a => a.name.endsWith('.eagleplugin'));
      if (!eaglePluginAsset) {
        throw new Error('.eagleplugin file not found in release assets.');
      }

      const buffer = await GitHub.downloadFile(eaglePluginAsset.browserDownloadUrl, token);
      const tempPath = pathModule.join(pluginsRoot, `_temp_${pluginId}.eagleplugin`);
      fs.writeFileSync(tempPath, buffer);

      try {
        // Try to extract as zip
        execSync(`powershell -Command "Expand-Archive -Path '${tempPath}' -DestinationPath '${targetDir}' -Force"`, { timeout: 30000 });
      } catch (e) {
        // If not a zip, try treating it as a directory copy
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
        fs.copyFileSync(tempPath, pathModule.join(targetDir, eaglePluginAsset.name));
      } finally {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      }
    } else if (validation.installMethod === 'assets') {
      // Download individual files from release assets
      const files = {};
      for (const asset of validation.release.assets) {
        if (asset.name === 'manifest.json' || asset.name.endsWith('.html') ||
            asset.name.endsWith('.js') || asset.name.endsWith('.css') ||
            asset.name.endsWith('.png') || asset.name.endsWith('.jpg') ||
            asset.name.endsWith('.svg') || asset.name.endsWith('.json')) {
          try {
            const content = await GitHub.downloadFile(asset.browserDownloadUrl, token);
            files[asset.name] = content;
          } catch (e) {
            console.warn(`BRAT: Failed to download ${asset.name}:`, e);
          }
        }
      }

      // If we didn't get enough files, try fetching from raw GitHub
      if (!files['manifest.json']) {
        return await installFromRaw(cleanRepo, validation.release.tagName, pluginId, token);
      }

      writeFiles(targetDir, files);
    } else {
      // installMethod === 'raw' - download from raw.githubusercontent.com
      return await installFromRaw(cleanRepo, validation.release.tagName, pluginId, token);
    }

    // Verify installation
    const installedManifestPath = pathModule.join(targetDir, 'manifest.json');
    if (!fs.existsSync(installedManifestPath)) {
      // Try to find manifest in subdirectory
      const subDirs = fs.readdirSync(targetDir).filter(f => {
        return fs.lstatSync(pathModule.join(targetDir, f)).isDirectory();
      });
      let found = false;
      for (const sub of subDirs) {
        const subManifest = pathModule.join(targetDir, sub, 'manifest.json');
        if (fs.existsSync(subManifest)) {
          // Move contents up
          const subDir = pathModule.join(targetDir, sub);
          const contents = fs.readdirSync(subDir);
          for (const item of contents) {
            const srcPath = pathModule.join(subDir, item);
            const destPath = pathModule.join(targetDir, item);
            fs.renameSync(srcPath, destPath);
          }
          fs.rmdirSync(subDir);
          found = true;
          break;
        }
      }
      if (!found) {
        removeDir(targetDir);
        throw new Error('Installation failed: manifest.json not found after extraction.');
      }
    }

    return {
      pluginId,
      name: pluginName,
      version: pluginVersion,
      description: manifest.description || '',
      repo: cleanRepo,
    };
  }

  // Install by downloading files from raw.githubusercontent.com
  async function installFromRaw(repo, tagName, pluginId, token) {
    // Try to get the file tree
    const treeUrl = `https://api.github.com/repos/${repo}/git/trees/${tagName}?recursive=1`;
    let filesToDownload = [];

    try {
      const { data } = await new Promise((resolve, reject) => {
        const https = require('https');
        const headers = {
          'User-Agent': 'Eagle-BRAT-Plugin/1.0',
          'Accept': 'application/vnd.github.v3+json',
        };
        if (token) headers['Authorization'] = `token ${token}`;

        https.get(treeUrl, { headers }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve({ data: JSON.parse(body) });
            } else {
              reject(new Error(`Failed to get tree: ${res.statusCode}`));
            }
          });
        }).on('error', reject);
      });

      filesToDownload = (data.tree || [])
        .filter(t => t.type === 'blob' && !t.path.startsWith('.') && !t.path.includes('node_modules'))
        .map(t => t.path);
    } catch (e) {
      // Fallback: try common file names
      filesToDownload = ['manifest.json', 'index.html', 'logo.png', 'js/plugin.js', 'js/app.js'];
    }

    const targetDir = pathModule.join(pluginsRoot, sanitizeDirName(pluginId));
    const files = {};

    for (const filePath of filesToDownload) {
      try {
        const rawUrl = `https://raw.githubusercontent.com/${repo}/${tagName}/${filePath}`;
        const content = await GitHub.downloadFile(rawUrl, token);
        files[filePath] = content;
      } catch (e) {
        // Skip files that don't exist
      }
    }

    if (!files['manifest.json']) {
      throw new Error('Failed to download manifest.json from repository.');
    }

    writeFiles(targetDir, files);

    const manifest = JSON.parse(files['manifest.json'].toString('utf-8'));
    return {
      pluginId: manifest.id,
      name: manifest.name,
      version: manifest.version || tagName,
      description: manifest.description || '',
      repo,
    };
  }

  // Uninstall a plugin
  function uninstallPlugin(pluginId) {
    // Find the plugin directory
    const entries = fs.readdirSync(pluginsRoot);
    for (const entry of entries) {
      const entryPath = pathModule.join(pluginsRoot, entry);
      if (!fs.lstatSync(entryPath).isDirectory()) continue;

      const manifestPath = pathModule.join(entryPath, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.id === pluginId) {
            removeDir(entryPath);
            return true;
          }
        } catch (e) {
          // Skip invalid manifests
        }
      }
    }
    return false;
  }

  // Toggle plugin enabled/disabled by renaming directory
  function togglePlugin(pluginId, enabled) {
    const entries = fs.readdirSync(pluginsRoot);
    for (const entry of entries) {
      const entryPath = pathModule.join(pluginsRoot, entry);
      if (!fs.lstatSync(entryPath).isDirectory()) continue;

      const manifestPath = pathModule.join(entryPath, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.id === pluginId) {
            if (enabled && entry.endsWith('.disabled')) {
              const newPath = pathModule.join(pluginsRoot, entry.replace('.disabled', ''));
              fs.renameSync(entryPath, newPath);
              return true;
            } else if (!enabled && !entry.endsWith('.disabled')) {
              const newPath = pathModule.join(pluginsRoot, entry + '.disabled');
              fs.renameSync(entryPath, newPath);
              return true;
            }
            return false;
          }
        } catch (e) {
          // Skip
        }
      }
    }
    return false;
  }

  // Scan all plugin directories on disk and return their manifest info
  // Check if a manifest.json belongs to an Eagle plugin (not a random npm/node project)
  function isEagleManifest(manifest) {
    // Eagle plugins must have: id (string), name (string), and a main config object
    if (!manifest || typeof manifest !== 'object') return false;
    if (typeof manifest.id !== 'string' || manifest.id.length === 0) return false;
    if (typeof manifest.name !== 'string' || manifest.name.length === 0) return false;

    // Eagle plugin IDs are alphanumeric (e.g. "LB5UL2P0Q9FFF"), not UUIDs or npm-style
    if (!/^[A-Za-z0-9_-]+$/.test(manifest.id)) return false;

    // Must have a main config for one of the 4 plugin types:
    // Window: main.url, Service: main.background, Format: main.thumbnail/preview, Inspector: main.inspector
    if (!manifest.main || typeof manifest.main !== 'object') return false;

    const main = manifest.main;
    const hasWindow = typeof main.url === 'string';
    const hasService = typeof main.background === 'string';
    const hasFormat = typeof main.thumbnail === 'string' || typeof main.preview === 'string';
    const hasInspector = typeof main.inspector === 'string';

    return hasWindow || hasService || hasFormat || hasInspector;
  }

  function scanInstalledPlugins() {
    const discovered = [];

    if (!pluginsRoot || !fs.existsSync(pluginsRoot)) {
      return discovered;
    }

    const entries = fs.readdirSync(pluginsRoot);
    for (const entry of entries) {
      const entryPath = pathModule.join(pluginsRoot, entry);
      if (!fs.lstatSync(entryPath).isDirectory()) continue;
      if (entry.startsWith('.')) continue; // skip hidden dirs

      const manifestPath = pathModule.join(entryPath, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        if (!isEagleManifest(manifest)) continue;

        const isDisabled = entry.endsWith('.disabled');
        const dirName = isDisabled ? entry.replace(/\.disabled$/, '') : entry;

        // Check if this plugin has a logo file
        let logoExists = false;
        if (manifest.logo) {
          const logoPath = pathModule.join(entryPath, manifest.logo);
          logoExists = fs.existsSync(logoPath);
        }

        discovered.push({
          pluginId: manifest.id,
          name: manifest.name,
          version: manifest.version || 'unknown',
          description: manifest.description || '',
          logo: manifest.logo || null,
          logoExists,
          dirName,
          isDisabled,
          entryPath,
          keywords: manifest.keywords || [],
        });
      } catch (e) {
        // Skip directories with invalid manifest
      }
    }

    return discovered;
  }

  // Find the directory for a given pluginId
  function findPluginDir(pluginId) {
    const entries = fs.readdirSync(pluginsRoot);
    for (const entry of entries) {
      if (!fs.lstatSync(pathModule.join(pluginsRoot, entry)).isDirectory()) continue;

      const manifestPath = pathModule.join(pluginsRoot, entry, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (manifest.id === pluginId) {
            return entry;
          }
        } catch (e) { /* skip */ }
      }

      // Also check .disabled dirs
      if (entry.endsWith('.disabled')) {
        const realManifestPath = pathModule.join(pluginsRoot, entry, 'manifest.json');
        if (fs.existsSync(realManifestPath)) {
          try {
            const manifest = JSON.parse(fs.readFileSync(realManifestPath, 'utf-8'));
            if (manifest.id === pluginId) {
              return entry;
            }
          } catch (e) { /* skip */ }
        }
      }
    }
    return null;
  }

  // Check for updates for all installed plugins
  async function checkAllUpdates(token, includePrereleases) {
    const plugins = Store.getPlugins();
    const updates = {};

    for (const [pluginId, info] of Object.entries(plugins)) {
      try {
        const { releases } = await GitHub.fetchReleases(info.repo, token, includePrereleases);
        if (releases.length > 0) {
          const latest = releases[0];
          if (latest.tagName !== info.version && latest.name !== info.version) {
            updates[pluginId] = {
              currentVersion: info.version,
              latestVersion: latest.tagName,
              latestName: latest.name,
            };
          }
        }
        Store.updatePluginInfo(pluginId, { lastChecked: new Date().toISOString() });
      } catch (e) {
        console.warn(`BRAT: Failed to check updates for ${pluginId}:`, e);
      }
    }

    return updates;
  }

  return {
    init,
    getPluginsRoot,
    installPlugin,
    uninstallPlugin,
    togglePlugin,
    scanInstalledPlugins,
    findPluginDir,
    checkAllUpdates,
  };
})();
