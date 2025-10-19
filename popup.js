const isFirefox = typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined';
const browserAPI = isFirefox ? browser : {
  storage: {
    sync: {
      get: (keys) => new Promise(resolve => chrome.storage.sync.get(keys, resolve)),
      set: (items) => new Promise(resolve => chrome.storage.sync.set(items, () => resolve()))
    }
  },
  tabs: {
    query: (queryInfo) => new Promise(resolve => chrome.tabs.query(queryInfo, resolve)),
    reload: (tabId) => new Promise(resolve => chrome.tabs.reload(tabId, () => resolve())),
    sendMessage: (tabId, message) => new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        const error = chrome.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve(response);
        }
      });
    })
  }
};

const defaultColors = {
  base: '#1e1e2e', mantle: '#181825', crust: '#11111b',
  surface0: '#313244', surface1: '#45475a', surface2: '#585b70',
  text: '#cdd6f4', subtext1: '#bac2de', subtext0: '#a6adc8',
  blue: '#89b4fa', sapphire: '#74c7ec', sky: '#89dceb',
  teal: '#94e2d5', green: '#a6e3a1', yellow: '#f9e2af',
  peach: '#fab387', red: '#f38ba8', mauve: '#cba6f7'
};

const defaultHue = {
  hueRotate: 180,
  saturate: 120,
  brightness: 110
};

document.addEventListener('DOMContentLoaded', async () => {
  let { theme = 'classic', disableHues = false, customColors = {}, customHue = {} } = await browserAPI.storage.sync.get(['theme', 'disableHues', 'customColors', 'customHue']);

  const themeRadio = document.querySelector(`input[value="${theme}"]`);
  if (themeRadio) {
    themeRadio.checked = true;
  }

  applyPopupTheme(theme);

  const settingsDiv = document.getElementById('catppuccin-settings');
  const customSettingsDiv = document.getElementById('custom-settings');

  if (theme === 'catppuccin') {
    settingsDiv.style.display = 'block';
  } else if (theme === 'custom') {
    customSettingsDiv.style.display = 'block';
  }

  const disableHuesCheckbox = document.getElementById('disable-hues');
  disableHuesCheckbox.checked = disableHues;

  Object.keys(defaultColors).forEach(key => {
    const input = document.getElementById(`ctp-${key}`);
    if (input) {
      input.value = customColors[key] || defaultColors[key];
      input.addEventListener('input', async (e) => {
        customColors[key] = e.target.value;
        await browserAPI.storage.sync.set({ customColors });
        notifyColorChange();
      });
    }
  });

  const themeRadios = document.querySelectorAll('input[name="theme"]');
  themeRadios.forEach(radio => {
    radio.addEventListener('change', async (e) => {
      const selectedTheme = e.target.value;

      await browserAPI.storage.sync.set({ theme: selectedTheme });
      applyPopupTheme(selectedTheme);

      settingsDiv.style.display = selectedTheme === 'catppuccin' ? 'block' : 'none';
      customSettingsDiv.style.display = selectedTheme === 'custom' ? 'block' : 'none';

      const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        try {
          await browserAPI.tabs.reload(tab.id);
        } catch (error) {
          console.error('Failed to reload active tab after theme change', error);
        }
      }
    });
  });

  disableHuesCheckbox.addEventListener('change', async (e) => {
    const disableHues = e.target.checked;
    await browserAPI.storage.sync.set({ disableHues });

    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await browserAPI.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_HUES',
          disableHues
        });
      } catch (error) {
        console.error('Failed to toggle hues in active tab', error);
      }
    }
  });

  const hueRotateInput = document.getElementById('hue-rotate');
  const saturateInput = document.getElementById('saturate');
  const brightnessInput = document.getElementById('brightness');

  const hueRotateValue = document.getElementById('hue-rotate-value');
  const saturateValue = document.getElementById('saturate-value');
  const brightnessValue = document.getElementById('brightness-value');

  hueRotateInput.value = customHue.hueRotate || defaultHue.hueRotate;
  saturateInput.value = customHue.saturate || defaultHue.saturate;
  brightnessInput.value = customHue.brightness || defaultHue.brightness;

  hueRotateValue.textContent = `${hueRotateInput.value}deg`;
  saturateValue.textContent = (saturateInput.value / 100).toFixed(1);
  brightnessValue.textContent = (brightnessInput.value / 100).toFixed(1);

  hueRotateInput.addEventListener('input', async (e) => {
    const value = parseInt(e.target.value);
    hueRotateValue.textContent = `${value}deg`;
    customHue.hueRotate = value;
    await browserAPI.storage.sync.set({ customHue });
    notifyHueChange();
  });

  saturateInput.addEventListener('input', async (e) => {
    const value = parseInt(e.target.value);
    saturateValue.textContent = (value / 100).toFixed(1);
    customHue.saturate = value;
    await browserAPI.storage.sync.set({ customHue });
    notifyHueChange();
  });

  brightnessInput.addEventListener('input', async (e) => {
    const value = parseInt(e.target.value);
    brightnessValue.textContent = (value / 100).toFixed(1);
    customHue.brightness = value;
    await browserAPI.storage.sync.set({ customHue });
    notifyHueChange();
  });

  document.getElementById('reset-custom').addEventListener('click', async () => {
    Object.keys(defaultColors).forEach(key => {
      const input = document.getElementById(`ctp-${key}`);
      if (input) input.value = defaultColors[key];
    });
    hueRotateInput.value = defaultHue.hueRotate;
    saturateInput.value = defaultHue.saturate;
    brightnessInput.value = defaultHue.brightness;
    hueRotateValue.textContent = `${defaultHue.hueRotate}deg`;
    saturateValue.textContent = (defaultHue.saturate / 100).toFixed(1);
    brightnessValue.textContent = (defaultHue.brightness / 100).toFixed(1);
    await browserAPI.storage.sync.set({ customColors: defaultColors, customHue: defaultHue });
    notifyColorChange();
    notifyHueChange();
  });
});

function applyPopupTheme(theme) {
  const popupTheme = theme === 'custom' ? 'catppuccin' : theme;
  document.body.setAttribute('data-theme', popupTheme);
}

async function notifyColorChange() {
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const { customColors } = await browserAPI.storage.sync.get('customColors');
      await browserAPI.tabs.sendMessage(tab.id, {
        type: 'UPDATE_CUSTOM_COLORS',
        customColors
      });
    }
  } catch (error) {
    console.error('Failed to notify color change', error);
  }
}

async function notifyHueChange() {
  try {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const { customHue } = await browserAPI.storage.sync.get('customHue');
      await browserAPI.tabs.sendMessage(tab.id, {
        type: 'UPDATE_CUSTOM_HUE',
        customHue
      });
    }
  } catch (error) {
    console.error('Failed to notify hue change', error);
  }
}
