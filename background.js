function parseJSObject(jsString) {
  jsString = jsString.replace(/\/\/.*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  let pos = 0;

  function parseValue() {
    skipWhitespace();
    const char = jsString[pos];

    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"' || char === "'") return parseString();
    if (char === 't' || char === 'f') return parseBoolean();
    if (char === 'n') return parseNull();
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();

    throw new Error(`Unexpected character at position ${pos}: ${char}`);
  }

  function parseObject() {
    const obj = {};
    pos++;
    skipWhitespace();

    while (jsString[pos] !== '}') {
      skipWhitespace();

      const key = parseKey();
      skipWhitespace();

      if (jsString[pos] !== ':') throw new Error(`Expected ':' at position ${pos}`);
      pos++;

      const value = parseValue();
      obj[key] = value;

      skipWhitespace();
      if (jsString[pos] === ',') {
        pos++;
        skipWhitespace();
        if (jsString[pos] === '}') break;
      }
    }

    pos++;
    return obj;
  }

  function parseArray() {
    const arr = [];
    pos++;
    skipWhitespace();

    while (jsString[pos] !== ']') {
      arr.push(parseValue());
      skipWhitespace();

      if (jsString[pos] === ',') {
        pos++;
        skipWhitespace();
        if (jsString[pos] === ']') break;
      }
    }

    pos++;
    return arr;
  }

  function parseKey() {
    skipWhitespace();

    if (jsString[pos] === '"' || jsString[pos] === "'") {
      return parseString();
    }

    let key = '';
    while (pos < jsString.length && /[a-zA-Z0-9_$]/.test(jsString[pos])) {
      key += jsString[pos++];
    }
    return key;
  }

  function parseString() {
    const quote = jsString[pos++];
    let str = '';

    while (pos < jsString.length && jsString[pos] !== quote) {
      if (jsString[pos] === '\\') {
        pos++;
        const escapeChar = jsString[pos];
        if (escapeChar === 'n') str += '\n';
        else if (escapeChar === 't') str += '\t';
        else if (escapeChar === 'r') str += '\r';
        else if (escapeChar === '\\') str += '\\';
        else if (escapeChar === quote) str += quote;
        else str += escapeChar;
        pos++;
      } else {
        str += jsString[pos++];
      }
    }

    pos++;
    return str;
  }

  function parseNumber() {
    let numStr = '';

    if (jsString[pos] === '-') numStr += jsString[pos++];

    while (pos < jsString.length && /[0-9.]/.test(jsString[pos])) {
      numStr += jsString[pos++];
    }

    return parseFloat(numStr);
  }

  function parseBoolean() {
    if (jsString.substr(pos, 4) === 'true') {
      pos += 4;
      return true;
    }
    if (jsString.substr(pos, 5) === 'false') {
      pos += 5;
      return false;
    }
    throw new Error(`Invalid boolean at position ${pos}`);
  }

  function parseNull() {
    if (jsString.substr(pos, 4) === 'null') {
      pos += 4;
      return null;
    }
    throw new Error(`Invalid null at position ${pos}`);
  }

  function skipWhitespace() {
    while (pos < jsString.length && /\s/.test(jsString[pos])) {
      pos++;
    }
  }

  return parseValue();
}

const isFirefox = typeof browser !== 'undefined' && typeof browser.runtime !== 'undefined';
const browserAPI = isFirefox ? browser : chrome;

browserAPI.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractShopItems') {
    const executeScriptCode = `
      (function() {
        const shopItemCards = document.querySelectorAll('.shop-item-card');
        if (shopItemCards.length > 0) {
          try {
            const allItems = [];
            let itemId = 1;

            const marketContainer = document.querySelector('.market-container');
            const descriptionsMap = new Map();

            const decodeHTML = (html) => {
              const txt = document.createElement('textarea');
              txt.innerHTML = html;
              return txt.value;
            };

            if (marketContainer) {
              const cosmeticsData = marketContainer.getAttribute('data-market-purchasable-cosmetics-value');
              const physicalData = marketContainer.getAttribute('data-market-purchasable-physical-items-value');

              try {
                if (cosmeticsData) {
                  const decoded = decodeHTML(cosmeticsData);
                  const cosmetics = JSON.parse(decoded);
                  cosmetics.forEach(item => {
                    if (item.name && item.description) {
                      descriptionsMap.set(item.name, item.description);
                    }
                  });
                }

                if (physicalData) {
                  const decoded = decodeHTML(physicalData);
                  const physical = JSON.parse(decoded);
                  physical.forEach(item => {
                    if (item.name && item.description) {
                      descriptionsMap.set(item.name, item.description);
                    }
                  });
                }
              } catch (e) {
                console.error('[Siege Utils] Failed to parse descriptions:', e);
              }
            }

            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
              const content = script.textContent || script.innerText;
              if (content) {
                const mercenaryMatch = content.match(/(?:mercenary|Mercenary).*?description["\s:]+["']([^"']+)["']/i);
                if (mercenaryMatch && mercenaryMatch[1] && !descriptionsMap.has('Mercenary')) {
                  descriptionsMap.set('Mercenary', decodeHTML(mercenaryMatch[1]));
                }

                const orangeMatch = content.match(/(?:orange.*?meeple|Unlock Orange Meeple).*?description["\s:]+["']([^"']+)["']/i);
                if (orangeMatch && orangeMatch[1] && !descriptionsMap.has('Unlock Orange Meeple')) {
                  descriptionsMap.set('Unlock Orange Meeple', decodeHTML(orangeMatch[1]));
                }
              }
            }

            shopItemCards.forEach(card => {
              const nameEl = card.querySelector('.shop-item-name');
              const costEl = card.querySelector('.shop-item-cost');
              const imgEl = card.querySelector('.shop-item-image');
              const stockEl = card.querySelector('.shop-item-stock');

              if (!nameEl || !costEl || !imgEl) return;

              const title = nameEl.textContent.trim();
              const costText = costEl.textContent.trim();
              const price = parseInt(costText.match(/\\d+/)?.[0] || '0');
              const image = imgEl.getAttribute('src');
              const alt = imgEl.getAttribute('alt');

              const isMercenary = title === 'Mercenary';
              const isCosmetic = imgEl.classList.contains('cosmetic');
              const isPhysical = imgEl.classList.contains('physical');
              const isDisabled = card.classList.contains('disabled');

              const item = {
                id: itemId++,
                title,
                price,
                image,
                description: descriptionsMap.get(title) || '',
                oneTime: !isMercenary,
                isCosmetic: isCosmetic,
                isPhysicalItem: isPhysical,
                disabled: isDisabled
              };

              if (stockEl) {
                const stockMatch = stockEl.textContent.match(/(\\d+)\\/(\\d+)/);
                if (stockMatch) {
                  item.currentStock = parseInt(stockMatch[1]);
                  item.maxPerWeek = parseInt(stockMatch[2]);
                  item.priceIncreases = true;
                }
              }

              allItems.push(item);
            });

            const shopItems = { other: allItems };
            return JSON.stringify(shopItems);
          } catch (e) {
            console.error('[Siege Utils] Failed to parse shop items from DOM:', e);
            return null;
          }
        }

        const scripts = Array.from(document.querySelectorAll('script'));
        for (const script of scripts) {
          const content = script.textContent || script.innerText;
          if (content && content.includes('allShopItems')) {
            const match = content.match(/const\\s+allShopItems\\s*=\\s*(\\{[\\s\\S]*?\\n\\s*\\});/);
            if (match && match[1]) {
              return match[1];
            }
          }
        }
        return null;
      })();
    `;

    const executeScript = isFirefox
      ? browserAPI.tabs.executeScript(sender.tab.id, { code: executeScriptCode })
      : browserAPI.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: () => {
            const shopItemCards = document.querySelectorAll('.shop-item-card');
            if (shopItemCards.length > 0) {
              try {
                const allItems = [];
                let itemId = 1;

                const marketContainer = document.querySelector('.market-container');
                const descriptionsMap = new Map();

                const decodeHTML = (html) => {
                  const txt = document.createElement('textarea');
                  txt.innerHTML = html;
                  return txt.value;
                };

                if (marketContainer) {
                  const cosmeticsData = marketContainer.getAttribute('data-market-purchasable-cosmetics-value');
                  const physicalData = marketContainer.getAttribute('data-market-purchasable-physical-items-value');

                  try {
                    if (cosmeticsData) {
                      const decoded = decodeHTML(cosmeticsData);
                      const cosmetics = JSON.parse(decoded);
                      cosmetics.forEach(item => {
                        if (item.name && item.description) {
                          descriptionsMap.set(item.name, item.description);
                        }
                      });
                    }

                    if (physicalData) {
                      const decoded = decodeHTML(physicalData);
                      const physical = JSON.parse(decoded);
                      physical.forEach(item => {
                        if (item.name && item.description) {
                          descriptionsMap.set(item.name, item.description);
                        }
                      });
                    }
                  } catch (e) {
                    console.error('[Siege Utils] Failed to parse descriptions:', e);
                  }
                }

                const scripts = Array.from(document.querySelectorAll('script'));
                for (const script of scripts) {
                  const content = script.textContent || script.innerText;
                  if (content) {
                    const mercenaryMatch = content.match(/(?:mercenary|Mercenary).*?description["\s:]+["']([^"']+)["']/i);
                    if (mercenaryMatch && mercenaryMatch[1] && !descriptionsMap.has('Mercenary')) {
                      descriptionsMap.set('Mercenary', decodeHTML(mercenaryMatch[1]));
                    }

                    const orangeMatch = content.match(/(?:orange.*?meeple|Unlock Orange Meeple).*?description["\s:]+["']([^"']+)["']/i);
                    if (orangeMatch && orangeMatch[1] && !descriptionsMap.has('Unlock Orange Meeple')) {
                      descriptionsMap.set('Unlock Orange Meeple', decodeHTML(orangeMatch[1]));
                    }
                  }
                }

                shopItemCards.forEach(card => {
                  const nameEl = card.querySelector('.shop-item-name');
                  const costEl = card.querySelector('.shop-item-cost');
                  const imgEl = card.querySelector('.shop-item-image');
                  const stockEl = card.querySelector('.shop-item-stock');

                  if (!nameEl || !costEl || !imgEl) return;

                  const title = nameEl.textContent.trim();
                  const costText = costEl.textContent.trim();
                  const price = parseInt(costText.match(/\d+/)?.[0] || '0');
                  const image = imgEl.getAttribute('src');
                  const alt = imgEl.getAttribute('alt');

                  const isMercenary = title === 'Mercenary';
                  const isCosmetic = imgEl.classList.contains('cosmetic');
                  const isPhysical = imgEl.classList.contains('physical');
                  const isDisabled = card.classList.contains('disabled');

                  const item = {
                    id: itemId++,
                    title,
                    price,
                    image,
                    description: descriptionsMap.get(title) || '',
                    oneTime: !isMercenary,
                    isCosmetic: isCosmetic,
                    isPhysicalItem: isPhysical,
                    disabled: isDisabled
                  };

                  if (stockEl) {
                    const stockMatch = stockEl.textContent.match(/(\d+)\/(\d+)/);
                    if (stockMatch) {
                      item.currentStock = parseInt(stockMatch[1]);
                      item.maxPerWeek = parseInt(stockMatch[2]);
                      item.priceIncreases = true;
                    }
                  }

                  allItems.push(item);
                });

                const shopItems = { other: allItems };
                return JSON.stringify(shopItems);
              } catch (e) {
                console.error('[Siege Utils] Failed to parse shop items from DOM:', e);
                return null;
              }
            }

            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
              const content = script.textContent || script.innerText;
              if (content && content.includes('allShopItems')) {
                const match = content.match(/const\s+allShopItems\s*=\s*(\{[\s\S]*?\n\s*\});/);
                if (match && match[1]) {
                  return match[1];
                }
              }
            }
            return null;
          }
        });

    executeScript.then(results => {
      const result = isFirefox ? results[0] : (results && results[0] && results[0].result);

      if (result) {
        try {
          let shopItems;
          if (result.startsWith('{') && (result.includes('"other"') || result.includes('"cosmetics"'))) {
            shopItems = JSON.parse(result);
          } else {
            shopItems = parseJSObject(result);
          }

          console.log('[Siege Utils] Successfully parsed shop items:', Object.keys(shopItems));
          sendResponse({ success: true, data: shopItems });
        } catch (parseError) {
          console.error('[Siege Utils] Failed to parse shop items:', parseError.message);
          sendResponse({ success: false, error: 'Failed to parse: ' + parseError.message });
        }
      } else {
        sendResponse({ success: false, error: 'Shop items not found in page' });
      }
    }).catch(error => {
      console.error('[Siege Utils] Script execution failed:', error);
      sendResponse({ success: false, error: error.message });
    });

    return true;
  }
});
