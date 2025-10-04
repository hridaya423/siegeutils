
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
  let { theme = 'classic', disableHues = false, customColors = {}, customHue = {} } = await chrome.storage.sync.get(['theme', 'disableHues', 'customColors', 'customHue']);

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
        await chrome.storage.sync.set({ customColors });
        notifyColorChange();
      });
    }
  });

  const themeRadios = document.querySelectorAll('input[name="theme"]');
  themeRadios.forEach(radio => {
    radio.addEventListener('change', async (e) => {
      const selectedTheme = e.target.value;

      await chrome.storage.sync.set({ theme: selectedTheme });
      applyPopupTheme(selectedTheme);

      settingsDiv.style.display = selectedTheme === 'catppuccin' ? 'block' : 'none';
      customSettingsDiv.style.display = selectedTheme === 'custom' ? 'block' : 'none';

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        chrome.tabs.reload(tab.id);
      }
    });
  });

  disableHuesCheckbox.addEventListener('change', async (e) => {
    const disableHues = e.target.checked;
    await chrome.storage.sync.set({ disableHues });

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, {
        type: 'TOGGLE_HUES',
        disableHues
      });
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
    await chrome.storage.sync.set({ customHue });
    notifyHueChange();
  });

  saturateInput.addEventListener('input', async (e) => {
    const value = parseInt(e.target.value);
    saturateValue.textContent = (value / 100).toFixed(1);
    customHue.saturate = value;
    await chrome.storage.sync.set({ customHue });
    notifyHueChange();
  });

  brightnessInput.addEventListener('input', async (e) => {
    const value = parseInt(e.target.value);
    brightnessValue.textContent = (value / 100).toFixed(1);
    customHue.brightness = value;
    await chrome.storage.sync.set({ customHue });
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
    await chrome.storage.sync.set({ customColors: defaultColors, customHue: defaultHue });
    notifyColorChange();
    notifyHueChange();
  });
});

function applyPopupTheme(theme) {
  document.body.setAttribute('data-theme', theme === 'custom' ? 'catppuccin' : theme);
}

function notifyColorChange() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.storage.sync.get('customColors', ({ customColors }) => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'UPDATE_CUSTOM_COLORS',
          customColors
        });
      });
    }
  });
}

function notifyHueChange() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab?.id) {
      chrome.storage.sync.get('customHue', ({ customHue }) => {
        chrome.tabs.sendMessage(tab.id, {
          type: 'UPDATE_CUSTOM_HUE',
          customHue
        });
      });
    }
  });
}
