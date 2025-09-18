let isActive = false;
let techTreeData = null;
let userCoins = 0;
let userPurchases = [];
let currentCategory = 'laptop';
let selectedDevice = null;

const utils = {
  getCSRFToken() {
    const tokenElement = document.querySelector('meta[name="csrf-token"]');
    return tokenElement ? tokenElement.getAttribute('content') : null;
  },

  async apiRequest(endpoint, options = {}) {
    const token = this.getCSRFToken();
    if (!token) throw new Error('CSRF token not found');

    const response = await fetch(`https://siege.hackclub.com${endpoint}`, {
      headers: {
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  },

  formatCoins(amount) {
    return `${amount} 🪙`;
  },

  canAfford(price) {
    return userCoins >= price;
  },

  isPurchased(itemName) {
    return userPurchases.some(p => p.item_name === itemName && p.quantity > 0);
  },

  getDefaultDevice(category) {
    if (!techTreeData || !techTreeData[category] || !techTreeData[category].initialNode.options) {
      return null;
    }
    return techTreeData[category].initialNode.options[0].id;
  }
};

const api = {
  async loadTechTreeData() {
    try {
      return await utils.apiRequest('/market/tech_tree_data');
    } catch (error) {
      return null;
    }
  },

  async loadUserData() {
    try {
      const [coins, purchases] = await Promise.all([
        utils.apiRequest('/market/user_coins'),
        utils.apiRequest('/market/user_purchases')
      ]);

      userCoins = coins.coins || 0;
      userPurchases = purchases.purchases || [];
      return true;
    } catch (error) {
      return false;
    }
  },

  async purchaseItem(itemName, coinsSpent) {
    try {
      const response = await utils.apiRequest('/market/purchase', {
        method: 'POST',
        body: JSON.stringify({
          item_name: itemName,
          coins_spent: coinsSpent
        })
      });

      if (response.success) {
        await this.loadUserData();
      }

      return response;
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
};

const components = {
  createHeader() {
    return `
      <header class="siege-shop-header">
        <h1 class="siege-shop-title">Market</h1>
        <div class="siege-coins-display">${utils.formatCoins(userCoins)}</div>
      </header>
    `;
  },

  createCategoryNav() {
    const categories = [
      { id: 'laptop', name: 'Laptop Upgrades' },
      { id: 'tablet', name: 'Tablet Upgrades' },
      { id: 'laptop_grant', name: 'Laptop Grant' },
      { id: 'other', name: 'Other Items' }
    ];

    return `
      <nav class="siege-category-nav">
        ${categories.map(cat => `
          <a href="#" class="siege-category-link ${currentCategory === cat.id ? 'active' : ''}"
             data-category="${cat.id}">
            ${cat.name}
          </a>
        `).join('')}
      </nav>
    `;
  },

  createDeviceSelector(category) {
    if (!techTreeData || !techTreeData[category] || !techTreeData[category].initialNode.options) {
      return '';
    }

    const options = techTreeData[category].initialNode.options;
    return `
      <div class="siege-device-selector">
        <select class="siege-device-dropdown" id="deviceSelector">
          <option value="">Choose your device...</option>
          ${options.map(option => `
            <option value="${option.id}" ${selectedDevice === option.id ? 'selected' : ''}>
              ${option.title}
            </option>
          `).join('')}
        </select>
      </div>
    `;
  },

  createItemCard(item) {
    const purchased = utils.isPurchased(item.title);
    const affordable = utils.canAfford(item.price);

    let statusClass = 'unaffordable';
    let statusText = 'Cannot afford';

    if (purchased) {
      statusClass = 'purchased';
      statusText = 'Purchased';
    } else if (affordable) {
      statusClass = 'affordable';
      statusText = 'Can afford';
    }

    const cardClass = `siege-item-card ${!affordable && !purchased ? 'disabled' : ''}`;

    return `
      <div class="${cardClass}" data-item='${JSON.stringify(item)}'>
        <div class="siege-item-header">
          ${item.image ? `<div class="siege-item-image"><img src="${item.image}" alt="${item.title}" /></div>` : ''}
          <div class="siege-item-header-text">
            <h3 class="siege-item-title">${item.title}</h3>
            <div class="siege-item-price">${utils.formatCoins(item.price)}</div>
          </div>
        </div>
        <div class="siege-item-description">${item.description}</div>
        <div class="siege-item-status">
          <span class="siege-status-badge ${statusClass}">${statusText}</span>
          ${item.requires ? `<span class="siege-status-badge">Requires: ${item.requires}</span>` : ''}
        </div>
      </div>
    `;
  },

  createItemGrid(items) {
    if (!items || items.length === 0) {
      return '<div class="siege-loading">No items available</div>';
    }

    return `
      <div class="siege-items-grid">
        ${items.map(item => this.createItemCard(item)).join('')}
      </div>
    `;
  },

  async createMainInterface() {
    const content = ['laptop', 'tablet', 'laptop_grant'].includes(currentCategory)
      ? this.createUpgradesLayout(currentCategory)
      : await this.createOtherItemsLayout();

    return `
      <div class="siege-shop-container">
        ${this.createHeader()}
        ${this.createCategoryNav()}
        <main class="siege-shop-content">
          ${content}
        </main>
      </div>
    `;
  },

  async createOtherItemsLayout() {
    let items = [
      { id: 1, title: "Mercenary", price: 35, description: "This meeple will fight for you for an hour. Purchase to skip a required hour of sieging!", image: "/assets/meeple/mercenary-63f27597.png" },
      { id: 2, title: "Unlock Orange Meeple", price: 50, description: "Not feeling your color? Try orange!", image: "/assets/meeple/meeple-orange-8af8d083.png" },
      { id: 3, title: "Random Sticker", price: 30, description: "Some random sticker from around hq. This will be sent with your next round of prizes.", image: "/assets/meeple/meeple-red-94f33c30.png" }
    ];

    try {
      const response = await utils.apiRequest('/market/mercenary_price');
      if (response && response.price) {
        items[0].price = response.price;
      }
    } catch (error) {

    }

    return this.createItemGrid(items);
  },

  createUpgradesLayout(category) {
    if (!techTreeData || !techTreeData[category]) {
      return '<div class="siege-loading">Loading upgrades...</div>';
    }

    return `
      ${this.createDeviceSelector(category)}  
      <div class="siege-upgrades-section">
        ${this.createUpgradeCategories(category)}
      </div>
    `;
  },

  createUpgradeCategories(category) {
    if (!selectedDevice || !techTreeData[category] || !techTreeData[category].branches[selectedDevice]) {
      return '<div class="siege-loading">Select a device to see upgrade paths</div>';
    }

    const branches = techTreeData[category].branches[selectedDevice];
    const noReqItems = [];
    const hasReqItems = [];

    Object.values(branches).forEach(item => {
      if (item.requires) {
        hasReqItems.push(item);
      } else {
        noReqItems.push(item);
      }
    });

    let upgradesHTML = '';

    if (noReqItems.length > 0) {
      upgradesHTML += `
        <div style="margin-bottom: 2rem;">
          <h3 style="margin-bottom: 1rem; text-align: center; font-size: 1.8rem;">Direct Upgrades</h3>
          <div class="siege-items-grid">
            ${noReqItems.map(item => this.createItemCard(item)).join('')}
          </div>
        </div>
      `;
    }

    if (hasReqItems.length > 0) {
      upgradesHTML += `
        <div>
          <h3 style="margin-bottom: 1rem; text-align: center; font-size: 1.8rem;">Advanced Upgrades</h3>
          <div class="siege-items-grid">
            ${hasReqItems.map(item => this.createItemCard(item)).join('')}
          </div>
        </div>
      `;
    }

    return upgradesHTML;
  },

  showModal(title, message, buttons = []) {
    const modal = document.createElement('div');
    modal.className = 'siege-modal-overlay';
    modal.style.display = 'flex';
    modal.innerHTML = `
      <div class="siege-modal-container">
        <div class="siege-modal-content">
          <h3 class="siege-modal-title">${title}</h3>
          <p class="siege-modal-message">${message}</p>
          <div class="siege-modal-actions">
            ${buttons.map(btn => `<button class="siege-button" data-action="${btn.action}">${btn.text}</button>`).join('')}
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    return modal;
  },

  showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'siege-toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
};

const handlers = {
  async handleCategoryChange(event) {
    event.preventDefault();
    if (!event.target.classList.contains('siege-category-link')) return;

    const category = event.target.dataset.category;
    if (category !== currentCategory) {
      currentCategory = category;
      if (['laptop', 'tablet', 'laptop_grant'].includes(category)) {
        selectedDevice = utils.getDefaultDevice(category);
      } else {
        selectedDevice = null;
      }
      await render();
    }
  },

  async handleDeviceChange(event) {
    selectedDevice = event.target.value;
    await render();
  },

  async handleItemClick(event) {
    const card = event.target.closest('.siege-item-card');
    if (!card || card.classList.contains('disabled')) return;

    try {
      const itemData = JSON.parse(card.dataset.item);

      if (utils.isPurchased(itemData.title)) {
        components.showToast('Item already purchased!');
        return;
      }

      if (!utils.canAfford(itemData.price)) {
        components.showToast('Not enough coins!');
        return;
      }

      const modal = components.showModal(
        'Confirm Purchase',
        `Purchase ${itemData.title} for ${utils.formatCoins(itemData.price)}?`,
        [
          { text: 'Cancel', action: 'cancel' },
          { text: 'Buy', action: 'confirm' }
        ]
      );

      modal.addEventListener('click', async (e) => {
        const action = e.target.dataset.action;
        if (action === 'cancel') {
          modal.remove();
        } else if (action === 'confirm') {
          modal.remove();

          const result = await api.purchaseItem(itemData.title, itemData.price);

          if (result.success) {
            components.showToast(`Successfully purchased ${itemData.title}!`);
            await render();
          } else {
            components.showToast(result.error || 'Purchase failed');
          }
        }
      });

    } catch (error) {
      components.showToast('Purchase failed');
    }
  }
};

async function render() {
  if (!isActive) return;

  const container = document.querySelector('.siege-shop-container');
  if (!container) return;

  const interfaceHTML = await components.createMainInterface();
  container.innerHTML = interfaceHTML;

  container.addEventListener('click', handlers.handleCategoryChange);
  container.addEventListener('change', handlers.handleDeviceChange);
  container.addEventListener('click', handlers.handleItemClick);
}

async function init() {
  if (!window.location.pathname.startsWith('/market') || isActive) {
    return;
  }

  try {
    const originalContainer = document.querySelector('.market-container');
    if (!originalContainer) {
      setTimeout(init, 500);
      return;
    }

    const [loadedTechTreeData, userDataLoaded] = await Promise.all([
      api.loadTechTreeData(),
      api.loadUserData()
    ]);

    if (!loadedTechTreeData || !userDataLoaded) {
      throw new Error('Failed to load required data');
    }

    techTreeData = loadedTechTreeData;
    isActive = true;

    if (currentCategory === 'laptop' || currentCategory === 'tablet' || currentCategory === 'laptop_grant') {
      selectedDevice = utils.getDefaultDevice(currentCategory);
    }

    document.body.classList.add('siege-utils-active');

    const newContainer = document.createElement('div');
    const interfaceHTML = await components.createMainInterface();
    newContainer.innerHTML = interfaceHTML;
    originalContainer.parentNode.insertBefore(newContainer, originalContainer);

    await render();

  } catch (error) {
    components.showToast('Failed to load Siege Utils: ' + error.message);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}