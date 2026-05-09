// store.js - Data persistence for Eagle BRAT
// Stores installed plugin list and settings as JSON files

const Store = (() => {
  const fs = require('fs');
  const pathModule = require('path');

  let dataPath = '';
  let data = {
    plugins: {},
    settings: {
      githubToken: '',
      checkUpdatesOnStart: true,
      includePrereleases: false,
    },
  };

  function init(pluginPath) {
    dataPath = pathModule.join(pluginPath, 'brat-data.json');
    load();
  }

  function load() {
    try {
      if (fs.existsSync(dataPath)) {
        const raw = fs.readFileSync(dataPath, 'utf-8');
        const parsed = JSON.parse(raw);
        data.plugins = parsed.plugins || {};
        data.settings = { ...data.settings, ...(parsed.settings || {}) };
      }
    } catch (e) {
      console.error('BRAT: Failed to load data:', e);
    }
  }

  function save() {
    try {
      fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error('BRAT: Failed to save data:', e);
    }
  }

  // Plugin operations
  function getPlugins() {
    return { ...data.plugins };
  }

  function getPlugin(pluginId) {
    return data.plugins[pluginId] || null;
  }

  function addPlugin(pluginId, info) {
    data.plugins[pluginId] = {
      repo: info.repo,
      version: info.version,
      name: info.name,
      description: info.description || '',
      installedAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
      enabled: true,
    };
    save();
  }

  function removePlugin(pluginId) {
    delete data.plugins[pluginId];
    save();
  }

  function updatePluginInfo(pluginId, updates) {
    if (data.plugins[pluginId]) {
      Object.assign(data.plugins[pluginId], updates);
      save();
    }
  }

  function hasPlugin(pluginId) {
    return pluginId in data.plugins;
  }

  // Settings operations
  function getSettings() {
    return { ...data.settings };
  }

  function saveSettings(newSettings) {
    Object.assign(data.settings, newSettings);
    save();
  }

  return {
    init,
    load,
    save,
    getPlugins,
    getPlugin,
    addPlugin,
    removePlugin,
    updatePluginInfo,
    hasPlugin,
    getSettings,
    saveSettings,
  };
})();
