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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'extractShopItems') {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: () => {
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
    }).then(results => {
      if (results && results[0] && results[0].result) {
        try {
          const shopItemsStr = results[0].result;

          const shopItems = parseJSObject(shopItemsStr);

          console.log('Successfully parsed shop items:', Object.keys(shopItems));
          sendResponse({ success: true, data: shopItems });
        } catch (parseError) {
          console.error('Failed to parse shop items:', parseError.message);
          sendResponse({ success: false, error: 'Failed to parse: ' + parseError.message });
        }
      } else {
        sendResponse({ success: false, error: 'allShopItems not found in page scripts' });
      }
    }).catch(error => {
      console.error('Script execution failed:', error);
      sendResponse({ success: false, error: error.message });
    });

    return true;
  }
});
