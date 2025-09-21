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

const projectStats = {
  getStoredStats() {
    const stored = localStorage.getItem('siege-utils-project-stats');
    return stored ? JSON.parse(stored) : {};
  },

  saveStats(stats) {
    localStorage.setItem('siege-utils-project-stats', JSON.stringify(stats));
  },

  parseTimeString(timeStr) {
    const match = timeStr.match(/(\d+)h\s*(\d+)m/);
    if (!match) return 0;
    const hours = parseInt(match[1]) || 0;
    const minutes = parseInt(match[2]) || 0;
    return hours + (minutes / 60);
  },

  parseCoins(coinStr) {
    const match = coinStr.match(/(\d+\.?\d*)/);
    return match ? parseFloat(match[1]) : 0;
  },

  parseWeek(weekStr) {
    const match = weekStr.match(/Week (\d+)/);
    return match ? parseInt(match[1]) : 1;
  },

  estimateReviewerAndVoterStats(totalCoins, week, hours) {
    if (!totalCoins || !hours) return { reviewerBonus: 1.0, avgVoterStars: 3.0 };

    let baseMultiplier;
    if (week <= 4) {
      baseMultiplier = 2;
    } else {
      if (hours <= 10) {
        baseMultiplier = 0.5;
      } else {
        baseMultiplier = (0.5 * 10 + 1 * (hours - 10)) / hours;
      }
    }

    const target = totalCoins / (baseMultiplier * hours);

    const validCombinations = [];

    for (let rb = 1.0; rb <= 3.0; rb = Math.round((rb + 0.1) * 10) / 10) {
      const avgStars = target / rb;

      if (avgStars >= 1.0 && avgStars <= 5.0) {
        const expectedStars = 1.0 + (rb - 1.0) * (4.0 / 2.0);
        const correlationDeviation = Math.abs(avgStars - expectedStars);

        validCombinations.push({
          reviewerBonus: rb,
          avgVoterStars: avgStars,
          correlationDeviation: correlationDeviation
        });
      }
    }

    if (validCombinations.length === 0) {
      return { reviewerBonus: 1.0, avgVoterStars: 3.0 };
    }

    validCombinations.sort((a, b) => a.correlationDeviation - b.correlationDeviation);

    const topResults = validCombinations.slice(0, Math.min(5, validCombinations.length));

    let totalRb = 0;
    let totalStars = 0;

    topResults.forEach((result) => {
      totalRb += result.reviewerBonus;
      totalStars += result.avgVoterStars;
    });

    const avgReviewerBonus = totalRb / topResults.length;
    const avgVoterStars = totalStars / topResults.length;

    return {
      reviewerBonus: Math.round(avgReviewerBonus * 100) / 100,
      avgVoterStars: Math.round(avgVoterStars * 100) / 100
    };
  },

  calculateEfficiency(totalCoins, hours) {
    if (!hours) return 0;
    return totalCoins / hours;
  },


  async extractProjectData(projectCard) {
    const projectId = projectCard.id.replace('project_', '');
    const titleElement = projectCard.querySelector('.project-title');
    const badgeElement = projectCard.querySelector('.project-badge');
    const timeElement = projectCard.querySelector('.project-time');
    const valueElement = projectCard.querySelector('.project-status-indicator');

    if (!titleElement || !timeElement || !valueElement) {
      return null;
    }

    const title = titleElement.textContent.trim();
    const week = badgeElement ? this.parseWeek(badgeElement.textContent) : 1;
    const timeStr = timeElement.textContent.replace('Time spent: ', '');
    const hours = this.parseTimeString(timeStr);
    const valueStr = valueElement.textContent;
    const totalCoins = this.parseCoins(valueStr);
    if (!totalCoins || totalCoins === 0) {
      return null;
    }

    if (!hours || hours === 0) {
      return null;
    }

    let stats = this.getStoredStats();

    const estimates = this.estimateReviewerAndVoterStats(totalCoins, week, hours);
    const coinsPerHour = this.calculateEfficiency(totalCoins, hours);

    const projectData = {
      projectId,
      title,
      week,
      hours,
      totalCoins,
      avgScore: estimates.avgVoterStars,
      reviewerBonus: estimates.reviewerBonus,
      coinsPerHour
    };

    stats[`project_${projectId}`] = {
      avg_score: estimates.avgVoterStars,
      reviewer_bonus: estimates.reviewerBonus,
      week: week,
      hours: parseFloat(hours.toFixed(2)),
      total_coins: totalCoins,
      coins_per_hour: parseFloat(coinsPerHour.toFixed(2))
    };
    this.saveStats(stats);

    return projectData;
  },

  createEfficiencyBadge(projectData) {
    const { coinsPerHour, reviewerBonus, avgScore, totalCoins, hours } = projectData;
    const maxEfficiency = 30;
    const percentage = Math.min((coinsPerHour / maxEfficiency) * 100, 100);

    let label = 'Low efficiency';
    if (percentage >= 70) {
      label = 'High efficiency';
    } else if (percentage >= 40) {
      label = 'Medium efficiency';
    } else {
      label = 'Low efficiency';
    }

    return `
      <div class="siege-efficiency-box" style="
        margin-top: 0.5rem;
        padding: 1rem;
        position: relative;
        border: 3px solid rgba(64, 43, 32, 0.75);
        background: transparent;
        transition: all 160ms ease;
      ">

        <div style="position: relative; z-index: 1; text-align: center;">
          <div style="font-size: 0.9rem; font-weight: 600; margin-bottom: 0.25rem;">
             ${coinsPerHour.toFixed(1)} 🪙/hour
          </div>
          <div style="font-size: 0.75rem; opacity: 0.8; margin-bottom: 0.25rem;">
            ${label} • top ${(100 - percentage).toFixed(0)}%
          </div>
          <div style="font-size: 0.9rem; font-weight: 500; margin-bottom: 0.2rem;">
            ~×${reviewerBonus.toFixed(2)} reviewer bonus
          </div>
          <div style="font-size: 0.9rem; font-weight: 500;">
            ~${avgScore}/5 ⭐ avg voter stars
          </div>
          <div style="font-size: 0.6rem; font-weight: 500;">
            Please do not fully trust this data, it can be inaccurate.
          </div>
        </div>
      </div>
    `;
  },

  createDetailedStats(projectData) {
    const { avgScore, reviewerBonus, week, hours, totalCoins, coinsPerHour } = projectData;
    const maxEfficiency = 30;
    const percentage = Math.min((coinsPerHour / maxEfficiency) * 100, 100);
    const efficiencyColor = percentage >= 70 ? '#059669' : percentage >= 40 ? '#d97706' : '#dc2626';

    return `
      <div class="reviewer-feedback-container">
        <h3 class="reviewer-feedback-title">Project Stats</h3>
        <div class="reviewer-feedback-content siege-project-stats-content">
          <div class="siege-project-stats-row">
            <span class="siege-project-stats-metric" style="color: ${efficiencyColor};">${coinsPerHour.toFixed(1)} 🪙/hour</span>
            <span class="siege-project-stats-secondary">(top ${(100 - percentage).toFixed(0)}%)</span>
          </div>
          <div class="siege-project-stats-row">
            <span class="siege-project-stats-metric">~×${reviewerBonus.toFixed(2)} reviewer bonus</span>
            <span class="siege-project-stats-metric">~${avgScore}/5 ⭐ avg voter stars</span>
          </div>
        </div>
        <div class="siege-project-stats-footer">
          Week ${week} • ${hours.toFixed(1)}h total • ${totalCoins} 🪙 earned
        </div>
        <div style="font-size: 0.6rem; font-weight: 500;">
            Please do not fully trust this data, it can be inaccurate.
          </div>
      </div>
    `;
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

async function enhanceProjectCards() {
  const projectCards = document.querySelectorAll('article.project-card[id^="project_"]');

  for (const card of projectCards) {
    if (card.querySelector('.siege-efficiency-box')) continue; 

    try {
      const projectData = await projectStats.extractProjectData(card);

      if (projectData) {
        const reviewerFeedback = card.querySelector('.reviewer-feedback-indicator');
        const projectFooter = card.querySelector('.project-footer');
        const targetElement = reviewerFeedback || projectFooter;

        if (targetElement) {
          const badge = projectStats.createEfficiencyBadge(projectData);
          targetElement.insertAdjacentHTML('afterend', badge);
        }
      }
    } catch (error) {
      console.error('Failed to enhance project card:', error);
    }
  }
}

async function enhanceProjectPage() {
  const urlMatch = window.location.pathname.match(/\/projects\/(\d+)/);
  if (!urlMatch) {
    return;
  }

  const projectId = urlMatch[1];

  if (document.querySelector('.siege-project-stats-content')) {
    return;
  }

  const stats = projectStats.getStoredStats();
  const storedData = stats[`project_${projectId}`];

  if (storedData) {

    const projectData = {
      projectId,
      week: storedData.week,
      hours: storedData.hours,
      totalCoins: storedData.total_coins,
      avgScore: storedData.avg_score,
      reviewerBonus: storedData.reviewer_bonus,
      coinsPerHour: storedData.coins_per_hour
    };

    const detailedStats = projectStats.createDetailedStats(projectData);

    const reviewerFeedback = document.querySelector('.reviewer-feedback-container');
    if (reviewerFeedback) {
      reviewerFeedback.insertAdjacentHTML('beforebegin', detailedStats);
    } else {
      const projectDetails = document.querySelector('.project-details');
      if (projectDetails) {
        projectDetails.insertAdjacentHTML('beforeend', detailedStats);
      }
    }
    return;
  }


  try {
    const timeElement = document.querySelector('.project-week-time');
    const valueElement = document.querySelector('.project-status-display');
    const titleElement = document.querySelector('.projects-title');
    const avgScoreElement = document.querySelector('.submit-button.submit-button--disabled');

    if (!timeElement || !valueElement || !titleElement || !avgScoreElement) {
      return;
    }

    const timeStr = timeElement.textContent.replace('Time spent: ', '');
    const hours = projectStats.parseTimeString(timeStr);
    const valueStr = valueElement.textContent;
    const totalCoins = projectStats.parseCoins(valueStr);
    const titleStr = titleElement.textContent;
    const week = projectStats.parseWeek(titleStr);

    const avgScoreMatch = avgScoreElement.textContent.match(/Avg\.\s*Score:\s*([\d.]+)/);
    const avgScore = avgScoreMatch ? parseFloat(avgScoreMatch[1]) : null;

    if (!hours || !totalCoins) {
      return;
    }

    const estimates = projectStats.estimateReviewerAndVoterStats(totalCoins, week, hours);
    const coinsPerHour = projectStats.calculateEfficiency(totalCoins, hours);

    const projectData = {
      projectId,
      week,
      hours,
      totalCoins,
      avgScore: avgScore || estimates.avgVoterStars,
      reviewerBonus: estimates.reviewerBonus,
      coinsPerHour
    };

    let stats = projectStats.getStoredStats();
    stats[`project_${projectId}`] = {
      avg_score: avgScore || estimates.avgVoterStars,
      reviewer_bonus: estimates.reviewerBonus,
      week: week,
      hours: hours,
      total_coins: totalCoins,
      coins_per_hour: coinsPerHour
    };
    projectStats.saveStats(stats);

    const detailedStats = projectStats.createDetailedStats(projectData);

    const reviewerFeedback = document.querySelector('.reviewer-feedback-indicator') ||
                            document.querySelector('[class*="reviewer"]') ||
                            document.querySelector('[class*="feedback"]');

    let insertionPoint;
    if (reviewerFeedback) {
      insertionPoint = reviewerFeedback;
      insertionPoint.insertAdjacentHTML('beforebegin', detailedStats);
    } else {
      insertionPoint = document.querySelector('.project-details') ||
                      document.querySelector('.project-content') ||
                      document.querySelector('.project-info') ||
                      document.querySelector('main') ||
                      document.querySelector('[class*="project"]') ||
                      document.querySelector('[class*="content"]');


      if (insertionPoint) {
        insertionPoint.insertAdjacentHTML('beforeend', detailedStats);
      } else {
        document.body.insertAdjacentHTML('beforeend', detailedStats);
      }
    }

  } catch (error) {
    console.error('Failed to enhance project page:', error);
  }
}

async function initProjectStats() {
  if (window.location.pathname === '/projects') {
    await enhanceProjectCards();
  } else if (window.location.pathname.match(/\/projects\/\d+/)) {
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
      try {
        await enhanceProjectPage();
        break;
      } catch (error) {
        retries++;
        if (retries < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }
}

if (typeof window !== 'undefined') {
  let lastPath = window.location.pathname;
  let navigationTimeout = null;

  function handleNavigation() {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;

      if (navigationTimeout) {
        clearTimeout(navigationTimeout);
      }

      navigationTimeout = setTimeout(() => {
        if (window.location.pathname.startsWith('/market')) {
          init();
        }

        initProjectStats();
        navigationTimeout = null;
      }, 300);
    }
  }

  document.addEventListener('turbo:load', handleNavigation);
  document.addEventListener('turbo:render', handleNavigation);
  document.addEventListener('turbo:visit', handleNavigation);
  document.addEventListener('turbo:frame-load', handleNavigation);

  document.addEventListener('turbolinks:load', handleNavigation);
  document.addEventListener('turbolinks:render', handleNavigation);
  document.addEventListener('turbolinks:visit', handleNavigation);

  new MutationObserver(handleNavigation).observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', handleNavigation);

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function() {
    originalPushState.apply(history, arguments);
    setTimeout(handleNavigation, 50);
  };

  history.replaceState = function() {
    originalReplaceState.apply(history, arguments);
    setTimeout(handleNavigation, 50);
  };
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    if (window.location.pathname.startsWith('/market')) {
      init();
    }
    initProjectStats();
  });
} else {
  if (window.location.pathname.startsWith('/market')) {
    init();
  }
  initProjectStats();
}