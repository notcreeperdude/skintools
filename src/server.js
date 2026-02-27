const express = require('express');
const SteamUser = require('steam-user');
const GlobalOffensive = require('globaloffensive');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── State ─────────────────────────────────────────────────────────────────────
const TOKEN_FILE = path.join(__dirname, '../.refresh_token.json');
let client = null;
let csgo = null;
let steamGuardResolver = null;
let connectionStatus = 'disconnected';
let steamId64 = null;
let currentLoginAccount = null; // tracks which account the active client is logging in as

// Schema lookup: `${defindex}_${paintindex}` → { name, iconUrl }
let itemSchema = {};
let schemaLoaded = false;
let pendingCraftResolve = null; // resolves when craftingComplete fires

// ── Token helpers (multi-account) ─────────────────────────────────────────────
// File format: { active: "username", accounts: { username: "refreshToken", ... } }
function loadTokenFile() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      // Migrate old single-account format
      if (data.accountName !== undefined && !data.accounts) {
        const migrated = { active: data.accountName, accounts: { [data.accountName]: data.token } };
        fs.writeFileSync(TOKEN_FILE, JSON.stringify(migrated));
        return migrated;
      }
      return data;
    }
  } catch {}
  return { active: null, accounts: {} };
}
function saveTokenFile(data) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(data));
}
function saveToken(accountName, token) {
  const data = loadTokenFile();
  if (!data.accounts) data.accounts = {};
  data.accounts[accountName] = token;
  data.active = accountName;
  saveTokenFile(data);
}
function loadToken() {
  const data = loadTokenFile();
  if (!data.active || !data.accounts?.[data.active]) return null;
  return { accountName: data.active, token: data.accounts[data.active] };
}
function setActiveAccount(accountName) {
  const data = loadTokenFile();
  if (!(accountName in (data.accounts || {}))) return false;
  data.active = accountName;
  saveTokenFile(data);
  return true;
}
function removeAccount(accountName) {
  const data = loadTokenFile();
  delete data.accounts[accountName];
  if (data.active === accountName) {
    data.active = Object.keys(data.accounts)[0] || null;
  }
  saveTokenFile(data);
  return data;
}
function clearToken() { try { fs.unlinkSync(TOKEN_FILE); } catch {} }

// ── Item schema (ByMykel CSGO-API) ────────────────────────────────────────────
// Fetches a community-maintained JSON of all CS2 skins with names + images.
// Separate lookup maps per item type to avoid def_index collisions between sources.
// skinsByKey:      `${weapon_id}_${paint_index}`
// cratesByDef:     def_index → item  (cases, capsules, souvenir packages, etc.)
// stickersByDef:   def_index → item  (sticker capsules opened = become applied to weapon, not in inv standalone)
// keysByDef:       def_index → item
// agentsByDef:     def_index → item
// collectByDef:    def_index → item
// musicByDef:      def_index → item
// graffitiByDef:   def_index → item
// patchesByDef:    def_index → item
const schemaByType = {};

async function loadItemSchema() {
  if (schemaLoaded) return;
  const BASE = 'https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api/en';
  const sources = [
    { type: 'skin',        url: `${BASE}/skins.json` },
    { type: 'crate',       url: `${BASE}/crates.json` },
    { type: 'sticker',     url: `${BASE}/stickers.json` },
    { type: 'sticker_slab',url: `${BASE}/sticker_slabs.json` },
    { type: 'graffiti',    url: `${BASE}/graffiti.json` },
    { type: 'agent',       url: `${BASE}/agents.json` },
    { type: 'patch',       url: `${BASE}/patches.json` },
    { type: 'musickit',    url: `${BASE}/music_kits.json` },
    { type: 'tool',        url: `${BASE}/tools.json` },
    { type: 'keychain',    url: `${BASE}/keychains.json` },
    { type: 'key',         url: `${BASE}/keys.json` },
    { type: 'collectible', url: `${BASE}/collectibles.json` },
  ];

  try {
    console.log('Loading CS2 item schema...');
    const results = await Promise.allSettled(
      sources.map(s => axios.get(s.url, { timeout: 20000 }).then(r => ({ type: s.type, data: r.data })))
    );

    for (const result of results) {
      if (result.status !== 'fulfilled') { console.warn('Schema source failed:', result.reason?.message); continue; }
      const { type, data } = result.value;
      // Some endpoints return { value: [...] }, some return plain arrays, some return objects keyed by id
      let items;
      if (Array.isArray(data)) items = data;
      else if (Array.isArray(data?.value)) items = data.value;
      else if (typeof data === 'object' && data !== null) items = Object.values(data);
      else items = [];
      const map = {};
      for (const item of items) {
        if (type === 'skin') {
          // Skins: key by weapon_id + paint_index — store full data for trade-up support
          const wid = item.weapon?.weapon_id;
          const pi = item.paint_index;
          if (wid != null && pi != null) map[`${wid}_${pi}`] = {
            name: item.market_hash_name || item.name,
            iconUrl: item.image || null,
            rarity: item.rarity?.id || null,
            minFloat: item.min_float ?? 0,
            maxFloat: item.max_float ?? 1,
            collections: item.collections?.map(c => c.id) || [],
            defIndex: wid,
            paintIndex: pi,
          };
        } else {
          // Everything else: key by def_index within its own type map
          if (item.def_index != null) map[String(item.def_index)] = { name: item.market_hash_name || item.name, iconUrl: item.image || null };
        }
      }
      schemaByType[type] = map;
      itemSchema = { ...itemSchema, ...( type === 'skin' ? map : {} ) };
    }

    schemaLoaded = true;
    const summary = Object.entries(schemaByType).map(([t,m]) => `${t}=${Object.keys(m).length}`).join(' ');
    console.log(`Schema loaded: ${summary}`);
  } catch (err) {
    console.warn('Schema load failed:', err.message);
  }
}

// Determine item type from GC item properties and look up in the right map.
// Graffiti items: def_index is the sealed container type (e.g. 1348),
//   but stickers[0].sticker_id is the actual pattern ID that maps to graffiti.json def_index.
// Cases/keys/etc: def_index maps directly.
function lookupSchema(item) {
  const def = String(item.def_index);
  const pi = item.paint_index;

  // If it has a paint_index it's a skin
  if (pi != null && pi !== 0) {
    const key = `${item.def_index}_${pi}`;
    if (schemaByType.skin?.[key]) return schemaByType.skin[key];
  }

  // Hardcoded overrides for veteran coins and birthday coin.
  // These share def_indexes with sticker slabs in ByMykel's data, but can be
  // distinguished by rarity: coins have rarity 1, sticker slabs have rarity 5+.
  if (item.def_index === 4950 && item.rarity === 1) {
    const has277 = item.attribute?.some(a => a.def_index === 277);
    return has277
      ? { name: '10 Year Veteran Coin', iconUrl: null }
      : { name: '5 Year Veteran Coin', iconUrl: null };
  }
  if (item.def_index === 1348 && item.rarity === 1 && item.attribute?.some(a => a.def_index === 277)) {
    return { name: 'Loyalty Badge', iconUrl: null };
  }

  // Sealed graffiti containers have a stickers array with sticker_id = pattern ID.
  // But pins/charms also have a stickers array, so only treat as graffiti if the
  // item def_index is NOT already known as something else (crate, collectible, etc).
  const alreadyKnown = schemaByType.crate?.[def] || schemaByType.key?.[def] ||
    schemaByType.agent?.[def] || schemaByType.collectible?.[def] ||
    schemaByType.musickit?.[def] || schemaByType.patch?.[def] || schemaByType.tool?.[def] || schemaByType.keychain?.[def];
  if (!alreadyKnown && item.stickers?.length > 0 && item.stickers[0].sticker_id != null) {
    const patternId = String(item.stickers[0].sticker_id);
    if (schemaByType.graffiti?.[patternId]) return schemaByType.graffiti[patternId];
    if (schemaByType.sticker?.[patternId]) {
      const s = schemaByType.sticker[patternId];
      const name = s.name?.replace(/^Sticker \| /, 'Graffiti | ') ?? s.name;
      return { ...s, name };
    }
  }

  // Try each non-skin type in priority order
  const typeOrder = ['crate', 'key', 'agent', 'collectible', 'musickit', 'patch', 'tool', 'keychain', 'sticker_slab', 'sticker'];
  for (const type of typeOrder) {
    if (schemaByType[type]?.[def]) return schemaByType[type][def];
  }

  return null;
}

// ── Steam client setup ────────────────────────────────────────────────────────
function createClients() {
  if (client) { try { client.logOff(); } catch {} }
  client = new SteamUser();
  csgo = new GlobalOffensive(client);

  client.on('loggedOn', () => {
    steamId64 = client.steamID?.getSteamID64?.() || client.steamID?.toString();
    console.log(`Logged in, SteamID: ${steamId64}`);
    connectionStatus = 'connecting';
    client.gamesPlayed([730]);
  });

  client.on('refreshToken', (token) => {
    if (currentLoginAccount) saveToken(currentLoginAccount, token);
  });

  client.on('steamGuard', (domain, callback) => {
    console.log('Steam Guard required');
    connectionStatus = 'steamguard';
    steamGuardResolver = callback;
  });

  client.on('error', (err) => {
    console.error('Steam error:', err.message);
    connectionStatus = 'error:' + err.message;
  });

  client.on('loggedOff', () => { connectionStatus = 'disconnected'; });

  csgo.on('connectedToGC', () => {
    console.log('Connected to CS2 GC!');
    connectionStatus = 'connected';
  });

  csgo.on('disconnectedFromGC', () => { connectionStatus = 'connecting'; });
  csgo.on('itemAcquired', (item) => { console.log(`GC item acquired late: def_index=${item.def_index} id=${item.id}`); });
  csgo.on('itemChanged', (item) => { console.log(`GC item changed: def_index=${item.def_index} id=${item.id}`); });
  csgo.on('craftingComplete', (blueprint, idList) => {
    console.log(`Crafting complete: blueprint=${blueprint}, new items=${idList.join(',')}`);
    if (pendingCraftResolve) {
      pendingCraftResolve({ success: true, newItemIds: idList });
      pendingCraftResolve = null;
    }
  });
  csgo.on('error', (err) => console.error('GC error:', err));
}

// ── Auth routes ───────────────────────────────────────────────────────────────
app.get('/api/auth/status', (req, res) => {
  const saved = loadToken();
  const tokenData = loadTokenFile();
  res.json({
    status: connectionStatus,
    hasSavedToken: !!saved?.token,
    savedAccountName: saved?.accountName || null,
    accounts: Object.keys(tokenData.accounts || {}),
    activeAccount: tokenData.active || null,
  });
});

app.get('/api/auth/accounts', (req, res) => {
  const tokenData = loadTokenFile();
  res.json({
    accounts: Object.keys(tokenData.accounts || {}),
    active: tokenData.active || null,
  });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  createClients();
  connectionStatus = 'connecting';
  currentLoginAccount = username;
  // Save username as placeholder so we know this account exists
  const data = loadTokenFile();
  if (!data.accounts) data.accounts = {};
  data.accounts[username] = data.accounts[username] || null;
  data.active = username;
  saveTokenFile(data);
  client.logOn({ accountName: username, password });
  res.json({ ok: true });
});

app.post('/api/auth/token-login', (req, res) => {
  const saved = loadToken();
  if (!saved?.token) return res.status(400).json({ error: 'No saved token' });
  createClients();
  connectionStatus = 'connecting';
  currentLoginAccount = saved.accountName;
  client.logOn({ refreshToken: saved.token });
  res.json({ ok: true });
});

app.post('/api/auth/switch', async (req, res) => {
  const { accountName } = req.body;
  if (!accountName) return res.status(400).json({ error: 'accountName required' });
  if (!setActiveAccount(accountName)) return res.status(404).json({ error: 'Account not found' });

  // Log off current session
  if (client) { try { client.logOff(); } catch {} }
  connectionStatus = 'connecting';
  steamId64 = null;

  // Log in with saved token for the new account
  const saved = loadToken();
  if (!saved?.token) {
    connectionStatus = 'disconnected';
    return res.status(400).json({ error: 'No saved token for that account — log in manually' });
  }
  createClients();
  currentLoginAccount = accountName;
  client.logOn({ refreshToken: saved.token });
  res.json({ ok: true, accountName });
});

app.post('/api/auth/remove-account', (req, res) => {
  const { accountName } = req.body;
  if (!accountName) return res.status(400).json({ error: 'accountName required' });
  const data = removeAccount(accountName);
  // If we removed the active account, disconnect
  if (connectionStatus === 'connected' && data.active !== accountName) {
    if (client) { try { client.logOff(); } catch {} }
    connectionStatus = 'disconnected';
    steamId64 = null;
  }
  res.json({ ok: true, accounts: Object.keys(data.accounts), active: data.active });
});

app.post('/api/auth/guard', (req, res) => {
  const { code } = req.body;
  if (!steamGuardResolver) return res.status(400).json({ error: 'No Steam Guard prompt active' });
  steamGuardResolver(code);
  steamGuardResolver = null;
  connectionStatus = 'connecting';
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearToken();
  if (client) { try { client.logOff(); } catch {} }
  connectionStatus = 'disconnected';
  steamId64 = null;
  res.json({ ok: true });
});

// ── GC guard ──────────────────────────────────────────────────────────────────
function requireGC(res) {
  if (connectionStatus !== 'connected') {
    res.status(503).json({ error: 'Not connected to GC', status: connectionStatus });
    return false;
  }
  return true;
}

// ── Inventory routes ──────────────────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  if (!requireGC(res)) return;
  const all = (csgo.inventory || []).filter(i => !(i.flags & 8) && i.origin !== 0); // exclude non-economy system items
  const storageUnits = all.filter(i => i.casket_contained_item_count != null).map(formatItem);
  const inventory = all.filter(i => i.casket_id == null && i.casket_contained_item_count == null).map(formatItem);
  res.json({ inventory, storageUnits });
});

app.get('/api/storage/:casketId', (req, res) => {
  if (!requireGC(res)) return;
  csgo.getCasketContents(req.params.casketId, (err, items) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ items: (items || []).map(formatItem) });
  });
});

app.post('/api/storage/:casketId/add-bulk', (req, res) => {
  if (!requireGC(res)) return;
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ error: 'itemIds array required' });
  itemIds.forEach((id, i) => setTimeout(() => csgo.addToCasket(req.params.casketId, id), i * 300));
  res.json({ ok: true, queued: itemIds.length });
});

app.post('/api/storage/:casketId/remove-bulk', (req, res) => {
  if (!requireGC(res)) return;
  const { itemIds } = req.body;
  if (!Array.isArray(itemIds) || !itemIds.length) return res.status(400).json({ error: 'itemIds array required' });
  itemIds.forEach((id, i) => setTimeout(() => csgo.removeFromCasket(req.params.casketId, id), i * 300));
  res.json({ ok: true, queued: itemIds.length });
});

// Debug: show all items grouped by resolved type + unknowns with raw GC data

// Debug: dump all raw GC fields for a specific def_index
app.get('/api/debug/gcfields/:defindex', (req, res) => {
  if (!requireGC(res)) return;
  const all = (csgo.inventory || []).filter(i => !(i.flags & 8) && i.origin !== 0); // exclude non-economy system items
  const all_unfiltered = csgo.inventory || [];
  const match = all_unfiltered.filter(i => String(i.def_index) === req.params.defindex);
  if (!match.length) return res.json({ error: 'not found' });
  res.json(match);
});

app.get('/api/debug/raw', (req, res) => {
  if (!requireGC(res)) return;
  const all = (csgo.inventory || []).filter(i => !(i.flags & 8) && i.origin !== 0); // exclude non-economy system items
  const items = all.filter(i => !i.paint_index && i.casket_contained_item_count == null && i.casket_id == null).map(i => {
    const schema = lookupSchema(i);
    return { def_index: i.def_index, quality: i.quality, resolved: schema?.name || null, fromType: schema ? '_lookupSchema' : null };
  });
  res.json({
    mapSizes: Object.fromEntries(Object.entries(schemaByType).map(([k,v]) => [k, Object.keys(v).length])),
    items
  });
});

app.get('/api/debug/items', (req, res) => {
  if (!requireGC(res)) return;
  const all = (csgo.inventory || []).filter(i => !(i.flags & 8) && i.origin !== 0); // exclude non-economy system items
  const summary = {};
  const unknowns = [];
  for (const item of all) {
    const schema = lookupSchema(item);
    const name = schema?.name || 'UNKNOWN';
    // Group by resolved name prefix (first word)
    const group = schema ? (name.includes('Sticker') ? 'Sticker' : name.includes('Case') ? 'Case' : name.includes('Key') ? 'Key' : 'Other:'+name.substring(0,30)) : 'UNKNOWN';
    summary[group] = (summary[group] || 0) + 1;
    if (!schema) unknowns.push({ def_index: item.def_index, paint_index: item.paint_index, quality: item.quality, rarity: item.rarity });
  }
  res.json({ total: all.length, summary, unknowns });
});

// Reload schema on demand
app.post('/api/refresh-web-inventory', async (req, res) => {
  schemaLoaded = false;
  await loadItemSchema();
  res.json({ ok: true, count: Object.keys(itemSchema).length });
});

// Debug: show raw skin schema entry for a defindex_paintindex
app.get('/api/debug/gcitem/:id', (req, res) => {
  if (!csgo?.inventory) return res.status(503).json({ error: 'Not connected' });
  const item = csgo.inventory.find(i => i.id?.toString() === req.params.id);
  if (!item) return res.json({ error: 'not found' });
  res.json({
    id: item.id?.toString(),
    def_index: item.def_index,
    paint_index: item.paint_index,
    quality: item.quality,
    rarity: item.rarity,
    flags: item.flags,
    origin: item.origin,
    casket_id: item.casket_id?.toString() || null,
    casket_contained_item_count: item.casket_contained_item_count ?? null,
    kill_eater_value: item.kill_eater_value ?? null,
    inventory: item.inventory,
  });
});

app.get('/api/debug/skin/:key', (req, res) => {
  const entry = schemaByType.skin?.[req.params.key];
  res.json(entry || { error: 'not found' });
});

// GET /api/tradeup/eligible — returns all inventory skins grouped by rarity with trade-up metadata
app.get('/api/tradeup/eligible', (req, res) => {
  if (!csgo?.inventory) return res.status(503).json({ error: 'Not connected' });
  const all = csgo.inventory;
  const now = new Date();
  const items = all.filter(i =>
    !(i.flags & 8) &&
    i.origin !== 0 &&
    i.casket_id == null &&
    i.casket_contained_item_count == null &&
    i.paint_index != null && i.paint_index !== 0 &&
    !(i.tradable_after && i.tradable_after > now)
  );

  const result = items.map(item => {
    const key = `${item.def_index}_${item.paint_index}`;
    const schema = schemaByType.skin?.[key] || {};
    return {
      id: item.id?.toString(),
      defIndex: item.def_index,
      paintIndex: item.paint_index,
      paintwear: item.paint_wear ?? null,
      stattrak: item.kill_eater_value !== undefined,
      name: schema.name || null,
      iconUrl: schema.iconUrl || null,
      rarity: schema.rarity || null,
      minFloat: schema.minFloat ?? 0,
      maxFloat: schema.maxFloat ?? 1,
      collections: schema.collections || [],
    };
  });

  res.json({ items: result });
});

// GET /api/tradeup/outputs?collections[]=...&rarity=...&stattrak=false
// Returns all possible output skins for a given set of collections + rarity
app.get('/api/tradeup/outputs', (req, res) => {
  const targetRarityMap = {
    'rarity_common_weapon':    'rarity_uncommon_weapon',
    'rarity_uncommon_weapon':  'rarity_rare_weapon',
    'rarity_rare_weapon':      'rarity_mythical_weapon',
    'rarity_mythical_weapon':  'rarity_legendary_weapon',
    'rarity_legendary_weapon': 'rarity_ancient_weapon',
  };

  const inputRarity = req.query.rarity;
  const targetRarity = targetRarityMap[inputRarity];
  if (!targetRarity) return res.json({ outputs: [] });

  const rawCollections = req.query['collections[]'] ?? req.query.collections;
  const inputCollections = Array.isArray(rawCollections)
    ? rawCollections
    : rawCollections ? [rawCollections] : [];

  // Find all skins of the target rarity that belong to any of the input collections
  const outputs = [];
  const skinMap = schemaByType.skin || {};
  for (const [key, skin] of Object.entries(skinMap)) {
    if (skin.rarity !== targetRarity) continue;
    const inCollection = skin.collections?.some(c => inputCollections.includes(c));
    if (inCollection) outputs.push({ ...skin, key });
  }

  res.json({ outputs, targetRarity });
});

// POST /api/tradeup/execute — performs the trade-up contract
// Body: { itemIds: [10 item id strings], rarity: string }
app.post('/api/tradeup/execute', async (req, res) => {
  if (!csgo || connectionStatus !== 'connected') return res.status(503).json({ error: 'Not connected to GC' });
  if (pendingCraftResolve) return res.status(409).json({ error: 'Another trade-up is in progress' });

  const { itemIds, rarity } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length !== 10) {
    return res.status(400).json({ error: 'Exactly 10 item IDs required' });
  }

  const recipeMap = {
    'rarity_common_weapon':    0,
    'rarity_uncommon_weapon':  1,
    'rarity_rare_weapon':      2,
    'rarity_mythical_weapon':  3,
    'rarity_legendary_weapon': 4,
  };
  const recipe = recipeMap[rarity];
  if (recipe === undefined) return res.status(400).json({ error: `Unknown rarity: ${rarity}` });

  try {
    const result = await new Promise((resolve, reject) => {
      pendingCraftResolve = resolve;
      const timeout = setTimeout(() => {
        pendingCraftResolve = null;
        reject(new Error('Trade-up timed out'));
      }, 15000);

      pendingCraftResolve = (result) => {
        clearTimeout(timeout);
        resolve(result);
      };

      console.log(`Crafting: recipe=${recipe} (rarity=${rarity}), items=[${itemIds.join(',')}]`);
      // Verify all items exist in GC inventory and log their origins
      const gcMap = new Map(csgo.inventory.map(i => [i.id?.toString(), i]));
      itemIds.forEach(id => {
        const i = gcMap.get(id);
        if (i) console.log(`  item ${id}: origin=${i.origin} flags=${i.flags} quality=${i.quality} rarity=${i.rarity} def=${i.def_index} paint=${i.paint_index}`);
        else console.warn(`  item ${id}: NOT FOUND in GC inventory`);
      });
      csgo.craft(itemIds, recipe);
    });

    res.json(result);
  } catch (err) {
    pendingCraftResolve = null;
    res.status(500).json({ error: err.message });
  }
});

// ── Item formatter ────────────────────────────────────────────────────────────
function formatItem(item) {
  const id = item.id?.toString();
  const schema = lookupSchema(item) || {};
  return {
    id,
    defindex: item.def_index,
    paintindex: item.paint_index,
    paintwear: item.paint_wear ?? null,
    paintseed: item.paint_seed ?? null,
    customName: item.custom_name || null,
    casketId: item.casket_id?.toString() || null,
    casketCount: item.casket_contained_item_count ?? null,
    stattrak: item.kill_eater_value !== undefined,
    stattrakValue: item.kill_eater_value ?? null,
    name: schema.name || null,
    iconUrl: schema.iconUrl || null,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🎮 SkinTools running at http://localhost:${PORT}\n`);

  // Load schema on startup (no auth required)
  loadItemSchema();

  // Auto-login with saved token if available
  const saved = loadToken();
  if (saved?.token) {
    console.log(`Auto-logging in as ${saved.accountName}...`);
    createClients();
    currentLoginAccount = saved.accountName;
    client.logOn({ refreshToken: saved.token });
  }
});
