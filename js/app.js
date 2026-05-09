// app.js - Main application logic and UI for Eagle BRAT

(() => {
  // DOM elements
  const inputRepo = document.getElementById('input-repo');
  const btnFetch = document.getElementById('btn-fetch');
  const btnInstall = document.getElementById('btn-install');
  const repoPreview = document.getElementById('repo-preview');
  const pluginList = document.getElementById('plugin-list');
  const pluginCount = document.getElementById('plugin-count');
  const btnCheckAll = document.getElementById('btn-check-all');
  const btnSettings = document.getElementById('btn-settings');
  const settingsModal = document.getElementById('settings-modal');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnCancelSettings = document.getElementById('btn-cancel-settings');
  const inputToken = document.getElementById('input-token');
  const checkUpdatesStartup = document.getElementById('check-updates-startup');
  const checkPrereleases = document.getElementById('check-prereleases');
  const notification = document.getElementById('notification');

  let currentRepoInfo = null;
  let currentReleases = null;

  // Initialize
  eagle.onPluginCreate((plugin) => {
    Store.init(plugin.path);
    Installer.init(plugin.path);
    renderPluginList();
    loadSettingsToUI();

    // Auto-check updates on startup if enabled
    const settings = Store.getSettings();
    if (settings.checkUpdatesOnStart) {
      setTimeout(() => checkAllUpdates(true), 3000);
    }
  });

  // Notification
  function notify(message, type = 'info', duration = 3000) {
    notification.textContent = message;
    notification.className = `notification ${type}`;
    notification.classList.remove('hidden');
    clearTimeout(notification._timer);
    notification._timer = setTimeout(() => {
      notification.classList.add('hidden');
    }, duration);
  }

  // Render plugin list — merges Store-tracked (BRAT-managed) + filesystem-scanned plugins
  function renderPluginList() {
    const tracked = Store.getPlugins(); // plugins installed/managed via BRAT
    const discovered = Installer.scanInstalledPlugins(); // all plugins on disk
    const trackedIds = new Set(Object.keys(tracked));

    // Build a merged list: tracked first, then discovered (excluding already tracked)
    const allPlugins = [];

    // 1. BRAT-managed plugins (have GitHub repo info)
    for (const [id, info] of Object.entries(tracked)) {
      allPlugins.push({
        pluginId: id,
        name: info.name,
        version: info.version,
        description: info.description || '',
        repo: info.repo,
        enabled: info.enabled !== false,
        source: 'brat',
        latestVersion: info.latestVersion || null,
        installedAt: info.installedAt || null,
      });
    }

    // 2. Discovered from filesystem (not managed by BRAT)
    for (const p of discovered) {
      if (!trackedIds.has(p.pluginId)) {
        allPlugins.push({
          pluginId: p.pluginId,
          name: p.name,
          version: p.version,
          description: p.description,
          repo: null,
          enabled: !p.isDisabled,
          source: 'manual',
          latestVersion: null,
          installedAt: null,
        });
      }
    }

    pluginCount.textContent = allPlugins.length;

    if (allPlugins.length === 0) {
      pluginList.innerHTML = `
        <div class="empty-state">
          <p>No plugins installed yet.</p>
          <p class="hint">Enter a GitHub repository address above to install a plugin.</p>
        </div>`;
      return;
    }

    // Sort: BRAT-managed first, then alphabetical
    allPlugins.sort((a, b) => {
      if (a.source !== b.source) return a.source === 'brat' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    pluginList.innerHTML = allPlugins.map((p) => {
      const sourceBadge = p.source === 'brat'
        ? '<span class="source-badge source-brat" title="Managed by BRAT (from GitHub)">GitHub</span>'
        : '<span class="source-badge source-manual" title="Manually installed">Local</span>';

      const repoLine = p.repo
        ? `<div class="plugin-repo">${escapeHtml(p.repo)}</div>`
        : '';

      const updateIndicator = p.source === 'brat' && p.latestVersion && p.latestVersion !== p.version
        ? `<span class="plugin-version has-update" title="Update available: ${escapeHtml(p.latestVersion)}">Update available</span>`
        : '';

      const installedDate = p.installedAt
        ? `<span class="plugin-meta">Installed: ${new Date(p.installedAt).toLocaleDateString()}</span>`
        : '';

      // BRAT-managed: full controls
      if (p.source === 'brat') {
        return `
          <div class="plugin-card" data-id="${p.pluginId}">
            <div class="plugin-info">
              <div class="plugin-name">
                ${escapeHtml(p.name)}
                <span class="plugin-version">${escapeHtml(p.version)}</span>
                ${updateIndicator}
                ${sourceBadge}
              </div>
              ${repoLine}
              ${p.description ? `<div class="plugin-desc">${escapeHtml(p.description)}</div>` : ''}
              ${installedDate}
            </div>
            <div class="plugin-actions">
              <button class="btn btn-sm btn-secondary btn-update" data-id="${p.pluginId}" title="Check for update">Update</button>
              <button class="btn btn-sm btn-secondary btn-toggle" data-id="${p.pluginId}" data-enabled="${p.enabled}" title="${p.enabled ? 'Disable' : 'Enable'}">
                ${p.enabled ? 'Disable' : 'Enable'}
              </button>
              <button class="btn btn-sm btn-danger btn-uninstall" data-id="${p.pluginId}" title="Uninstall">Uninstall</button>
            </div>
          </div>`;
      }

      // Manually installed: limited controls (no update, can link repo)
      return `
        <div class="plugin-card" data-id="${p.pluginId}">
          <div class="plugin-info">
            <div class="plugin-name">
              ${escapeHtml(p.name)}
              <span class="plugin-version">${escapeHtml(p.version)}</span>
              ${sourceBadge}
            </div>
            ${p.description ? `<div class="plugin-desc">${escapeHtml(p.description)}</div>` : ''}
          </div>
          <div class="plugin-actions">
            <button class="btn btn-sm btn-primary btn-link-repo" data-id="${p.pluginId}" data-name="${escapeHtml(p.name)}" title="Link a GitHub repo to enable updates">Link Repo</button>
            <button class="btn btn-sm btn-secondary btn-toggle" data-id="${p.pluginId}" data-enabled="${p.enabled}" title="${p.enabled ? 'Disable' : 'Enable'}">
              ${p.enabled ? 'Disable' : 'Enable'}
            </button>
            <button class="btn btn-sm btn-danger btn-uninstall" data-id="${p.pluginId}" title="Uninstall">Uninstall</button>
          </div>
        </div>`;
    }).join('');
  }

  // Escape HTML
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Fetch repo info
  btnFetch.addEventListener('click', async () => {
    const repoInput = inputRepo.value.trim();
    if (!repoInput) {
      notify('Please enter a GitHub repository address.', 'warning');
      return;
    }

    const repo = GitHub.scrubRepo(repoInput);
    if (!GitHub.isValidRepoFormat(repo)) {
      notify('Invalid repository format. Use: username/repo', 'error');
      return;
    }

    btnFetch.disabled = true;
    btnFetch.innerHTML = '<span class="spinner"></span> Fetching...';
    repoPreview.classList.add('hidden');
    btnInstall.disabled = true;
    currentRepoInfo = null;
    currentReleases = null;

    try {
      const token = Store.getSettings().githubToken;
      const includePrereleases = Store.getSettings().includePrereleases;

      // Fetch repo info and releases in parallel
      const [repoResult, releasesResult] = await Promise.all([
        GitHub.fetchRepoInfo(repo, token),
        GitHub.fetchReleases(repo, token, includePrereleases),
      ]);

      currentRepoInfo = repoResult.info;
      currentReleases = releasesResult.releases;

      if (currentReleases.length === 0) {
        notify('No releases found for this repository.', 'warning');
        return;
      }

      // Show preview
      const latest = currentReleases[0];
      const isInstalled = Store.hasPlugin(currentRepoInfo.fullName.split('/')[1]) ||
                          Object.values(Store.getPlugins()).some(p => p.repo === repo);

      repoPreview.innerHTML = `
        <div class="repo-name">${escapeHtml(currentRepoInfo.fullName)}</div>
        <div class="repo-desc">${escapeHtml(currentRepoInfo.description)}</div>
        <div class="repo-meta">
          <span>Stars: ${currentRepoInfo.stars}</span>
          <span>Releases: ${currentReleases.length}</span>
        </div>
        <div class="version-select">
          <label>Version:</label>
          <select id="select-version">
            ${currentReleases.map((r, i) => `
              <option value="${r.tagName}" ${i === 0 ? 'selected' : ''}>
                ${escapeHtml(r.name)}${r.prerelease ? ' (pre-release)' : ''} - ${new Date(r.publishedAt).toLocaleDateString()}
              </option>
            `).join('')}
          </select>
        </div>
      `;
      repoPreview.classList.remove('hidden');

      if (isInstalled) {
        btnInstall.textContent = 'Reinstall';
      } else {
        btnInstall.textContent = 'Install';
      }
      btnInstall.disabled = false;
    } catch (e) {
      notify(e.message || 'Failed to fetch repository info.', 'error');
    } finally {
      btnFetch.disabled = false;
      btnFetch.textContent = 'Fetch';
    }
  });

  // Install plugin
  btnInstall.addEventListener('click', async () => {
    if (!currentRepoInfo) return;

    const versionSelect = document.getElementById('select-version');
    const selectedVersion = versionSelect ? versionSelect.value : undefined;
    const token = Store.getSettings().githubToken;

    btnInstall.disabled = true;
    btnInstall.innerHTML = '<span class="spinner"></span> Installing...';

    try {
      const result = await Installer.installPlugin(currentRepoInfo.fullName, selectedVersion, token);

      Store.addPlugin(result.pluginId, {
        repo: result.repo,
        version: result.version,
        name: result.name,
        description: result.description,
      });

      renderPluginList();
      notify(`Plugin "${result.name}" installed successfully! Restart Eagle to activate.`, 'success', 5000);

      // Reset form
      repoPreview.classList.add('hidden');
      inputRepo.value = '';
      btnInstall.disabled = true;
      btnInstall.textContent = 'Install';
      currentRepoInfo = null;
      currentReleases = null;
    } catch (e) {
      notify(e.message || 'Installation failed.', 'error');
    } finally {
      btnInstall.disabled = false;
      btnInstall.textContent = 'Install';
    }
  });

  // Plugin card actions (delegated)
  pluginList.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    const pluginId = btn.dataset.id;
    if (!pluginId) return;

    if (btn.classList.contains('btn-uninstall')) {
      const tracked = Store.getPlugin(pluginId);
      const label = tracked ? tracked.name : pluginId;
      if (!confirm(`Uninstall "${label}"? This will delete its files.`)) return;

      try {
        Installer.uninstallPlugin(pluginId);
        Store.removePlugin(pluginId);
        renderPluginList();
        notify('Plugin uninstalled. Restart Eagle to take effect.', 'success');
      } catch (e) {
        notify('Failed to uninstall plugin.', 'error');
      }
    }

    if (btn.classList.contains('btn-toggle')) {
      const tracked = Store.getPlugin(pluginId);
      // For untracked plugins, determine current enabled state from filesystem
      let currentEnabled = true;
      if (tracked) {
        currentEnabled = tracked.enabled !== false;
      } else {
        // Check if dir has .disabled suffix
        const dirName = Installer.findPluginDir(pluginId);
        if (dirName) currentEnabled = !dirName.endsWith('.disabled');
      }

      const newEnabled = !currentEnabled;
      try {
        Installer.togglePlugin(pluginId, newEnabled);
        if (tracked) {
          Store.updatePluginInfo(pluginId, { enabled: newEnabled });
        }
        renderPluginList();
        notify(`Plugin ${newEnabled ? 'enabled' : 'disabled'}. Restart Eagle to take effect.`, 'info');
      } catch (e) {
        notify('Failed to toggle plugin.', 'error');
      }
    }

    if (btn.classList.contains('btn-update')) {
      const plugin = Store.getPlugin(pluginId);
      if (!plugin) return;

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';

      try {
        const token = Store.getSettings().githubToken;
        const result = await Installer.installPlugin(plugin.repo, undefined, token);

        Store.updatePluginInfo(pluginId, {
          version: result.version,
          lastChecked: new Date().toISOString(),
        });
        renderPluginList();
        notify(`Plugin updated to ${result.version}. Restart Eagle to activate.`, 'success');
      } catch (e) {
        notify(e.message || 'Update failed.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Update';
      }
    }

    // Link a GitHub repo to a manually installed plugin
    if (btn.classList.contains('btn-link-repo')) {
      const pluginName = btn.dataset.name || pluginId;
      const repoUrl = prompt(`Link a GitHub repository to "${pluginName}" for update tracking.\nEnter repo (e.g. username/repo):`);
      if (!repoUrl) return;

      const repo = GitHub.scrubRepo(repoUrl);
      if (!GitHub.isValidRepoFormat(repo)) {
        notify('Invalid repository format. Use: username/repo', 'error');
        return;
      }

      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span>';

      try {
        const token = Store.getSettings().githubToken;
        // Validate and get info
        const validation = await GitHub.validateEaglePlugin(repo, undefined, token);
        if (!validation.valid) {
          notify(validation.error || 'Not a valid Eagle plugin repository.', 'error');
          return;
        }

        // Read current version from disk
        const discovered = Installer.scanInstalledPlugins();
        const diskPlugin = discovered.find(p => p.pluginId === pluginId);
        const currentVersion = diskPlugin ? diskPlugin.version : validation.manifest.version || 'unknown';

        Store.addPlugin(pluginId, {
          repo,
          version: currentVersion,
          name: pluginName,
          description: validation.manifest.description || '',
        });

        renderPluginList();
        notify(`Linked "${pluginName}" to ${repo}. Restart Eagle to activate.`, 'success');
      } catch (e) {
        notify(e.message || 'Failed to link repository.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Link Repo';
      }
    }
  });

  // Enter key on input
  inputRepo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnFetch.click();
    }
  });

  // Check all updates
  async function checkAllUpdates(silent = false) {
    btnCheckAll.disabled = true;
    btnCheckAll.innerHTML = '<span class="spinner"></span> Checking...';

    try {
      const token = Store.getSettings().githubToken;
      const includePrereleases = Store.getSettings().includePrereleases;
      const updates = await Installer.checkAllUpdates(token, includePrereleases);
      const updateCount = Object.keys(updates).length;

      if (updateCount > 0) {
        // Mark plugins with updates
        for (const [id, info] of Object.entries(updates)) {
          Store.updatePluginInfo(id, { latestVersion: info.latestVersion });
        }
        renderPluginList();
        notify(`${updateCount} plugin(s) have updates available.`, 'info');
      } else if (!silent) {
        notify('All plugins are up to date.', 'success');
      }
    } catch (e) {
      if (!silent) {
        notify('Failed to check for updates.', 'error');
      }
    } finally {
      btnCheckAll.disabled = false;
      btnCheckAll.textContent = 'Check Updates';
    }
  }

  btnCheckAll.addEventListener('click', () => checkAllUpdates(false));

  // Settings modal
  function loadSettingsToUI() {
    const settings = Store.getSettings();
    inputToken.value = settings.githubToken || '';
    checkUpdatesStartup.checked = settings.checkUpdatesOnStart !== false;
    checkPrereleases.checked = settings.includePrereleases === true;
  }

  btnSettings.addEventListener('click', () => {
    loadSettingsToUI();
    settingsModal.classList.remove('hidden');
  });

  btnCloseSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  btnCancelSettings.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  // Close modal on overlay click
  settingsModal.querySelector('.modal-overlay').addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });

  btnSaveSettings.addEventListener('click', () => {
    Store.saveSettings({
      githubToken: inputToken.value.trim(),
      checkUpdatesOnStart: checkUpdatesStartup.checked,
      includePrereleases: checkPrereleases.checked,
    });
    settingsModal.classList.add('hidden');
    notify('Settings saved.', 'success');
  });

})();
