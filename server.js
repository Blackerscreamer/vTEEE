// server.js
// Achtung: Credentials sind hier direkt im Code (wie gewünscht). Nicht öffentlich teilen!
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const sharp = require('sharp');

/////////////////////
// Konfiguration -- passe BASE_URL / PORT an deinen Server an
/////////////////////
const CLIENT_ID = '1w0y4rdnuvbe476';
const CLIENT_SECRET = 'je5paqlcai1vxhc';
const REFRESH_TOKEN = 'L4N3aNJBnM8AAAAAAAAAAX9jprkmTjHaduGuaKzGxtnODQ5UhEzEUIvgUFXQ3uop';

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`; // ÄNDERE das falls du eine Domain verwendest, z.B. 'https://meineserverdomain.de'
const CACHE_DIR = path.join(__dirname, 'cache');
const MAPPINGS_FILE = path.join(CACHE_DIR, 'mappings.json');

fs.ensureDirSync(CACHE_DIR);

// Lade vorhandene Mappings (persistiert auf Festplatte)
let mappings = {};
if (fs.existsSync(MAPPINGS_FILE)) {
  try { mappings = fs.readJsonSync(MAPPINGS_FILE); } catch (e) { mappings = {}; }
}
function saveMappings() {
  try { fs.writeJsonSync(MAPPINGS_FILE, mappings, { spaces: 2 }); } catch (e) { console.error('Failed to save mappings', e); }
}

// Multer (in-memory)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 80 * 1024 * 1024 } }); // 80 MB Limit

const app = express();
app.use(express.json());

/** Helper: AccessToken mit Refresh Token holen */
async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Dropbox-Credentials fehlen.');
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', REFRESH_TOKEN);

  const resp = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Dropbox token refresh failed: ' + txt);
  }
  const data = await resp.json();
  return data.access_token;
}

/** Helper: Datei zu Dropbox hochladen */
async function uploadToDropbox(accessToken, dropboxPath, buffer) {
  const resp = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({
        path: dropboxPath,
        mode: 'add',
        autorename: true,
        mute: true
      })
    },
    body: buffer
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error('Dropbox upload failed: ' + txt);
  }
  return resp.json();
}

/** Helper: shared link erzeugen (optional, wir dienen aber aus lokalem Cache) */
async function createSharedLink(accessToken, pathOnDropbox) {
  const url = 'https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      path: pathOnDropbox,
      settings: {}
    })
  });

  const data = await resp.json();
  if (resp.status >= 400) {
    // fallback: bereits existierender Link
    try {
      const listResp = await fetch('https://api.dropboxapi.com/2/sharing/list_shared_links', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ path: pathOnDropbox, direct_only: true })
      });
      const listData = await listResp.json();
      if (listData && listData.links && listData.links.length > 0) return listData.links[0].url;
    } catch (e) { /* ignore */ }
    throw new Error('create_shared_link failed: ' + JSON.stringify(data));
  }
  return data.url;
}

//////////////////////////////
// ROUTES
//////////////////////////////

// GET / -> HTML Formular zum Hochladen
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Upload - Dropbox Image Server</title>
  <style>
    body { font-family: Arial, Helvetica, sans-serif; max-width:800px; margin:40px auto; padding:10px; }
    input, button { font-size: 1rem; padding:8px; margin:6px 0; }
    .preview { margin-top:20px; }
    img { max-width:100%; height:auto; display:block; margin-top:10px; border:1px solid #ddd; padding:6px; border-radius:6px; }
  </style>
</head>
<body>
  <h1>Bild hochladen</h1>
  <form id="uploadForm">
    <label>Bild auswählen (Feldname "image")</label><br/>
    <input type="file" name="image" id="imageInput" accept="image/*" required /><br/>
    <label>Breite (optional)</label><br/>
    <input type="number" id="width" placeholder="z.B. 200" min="1" /><br/>
    <label>Höhe (optional)</label><br/>
    <input type="number" id="height" placeholder="z.B. 200" min="1" /><br/>
    <button type="submit">Hochladen</button>
  </form>

  <div class="preview" id="resultArea"></div>

  <script>
    const form = document.getElementById('uploadForm');
    const resultArea = document.getElementById('resultArea');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('imageInput');
      if (!fileInput.files || fileInput.files.length === 0) return alert('Wähle eine Datei.');
      const width = document.getElementById('width').value;
      const height = document.getElementById('height').value;
      const fd = new FormData();
      fd.append('image', fileInput.files[0]);
      try {
        const r = await fetch('/upload', { method: 'POST', body: fd });
        const data = await r.json();
        if (!r.ok) { resultArea.innerText = 'Fehler: ' + (data.error || JSON.stringify(data)); return; }
        // show link and preview
        const url = data.url + (width || height ? ('?'+ (width ? 'width=' + encodeURIComponent(width) : '') + (width && height ? '&' : '') + (height ? 'height=' + encodeURIComponent(height) : '')) : '');
        resultArea.innerHTML = '<p>Dein Link: <a href="'+url+'" target="_blank">'+url+'</a></p>' +
                               '<p>Vorschau:</p><img src="'+url+'" alt="Vorschau" />';
      } catch (err) {
        resultArea.innerText = 'Upload fehlgeschlagen: ' + err.message;
      }
    });
  </script>
</body>
</html>`);
});

// POST /upload - Datei entgegennehmen, lokal speichern, Dropbox-Upload, Link generieren
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Kein Bild hochgeladen (Feldname: image)' });

    const buf = req.file.buffer;
    const originalName = req.file.originalname || 'upload.jpg';
    const ext = path.extname(originalName) || '.jpg';
    const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,''); // YYYYMMDD
    const id = uuidv4().replace(/-/g,'').slice(0,28);
    const dropboxPath = `/uploads/img/${dateStr}/${id}${ext}`;

    const localDir = path.join(CACHE_DIR, 'uploads', 'img', dateStr, id);
    await fs.ensureDir(localDir);
    const localOriginalPath = path.join(localDir, `original${ext}`);
    await fs.writeFile(localOriginalPath, buf);

    // Upload zu Dropbox (nur damit Dropbox eine Kopie hat), wir dienen aber aus lokalem Cache
    let accessToken = null;
    try {
      accessToken = await getAccessToken();
      await uploadToDropbox(accessToken, dropboxPath, buf);
    } catch (err) {
      console.warn('Dropbox upload fehlgeschlagen (fahre fort, lokal gespeichert):', err.message || err);
    }

    // optional shared link (nicht benötigt für unseren Proxy)
    let sharedLink = null;
    if (accessToken) {
      try { sharedLink = await createSharedLink(accessToken, dropboxPath); } catch (e) { /* ignore */ }
    }

    // Mapping persistieren
    const publicPath = `/uploads/img/${dateStr}/${id}/`;
    mappings[publicPath] = {
      id, date: dateStr, ext, localOriginalPath, dropboxPath, sharedLink, createdAt: new Date().toISOString()
    };
    saveMappings();

    const fullUrl = `${BASE_URL}${publicPath}`;
    return res.json({ url: fullUrl });
  } catch (err) {
    console.error('Upload error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});

// GET /uploads/img/:date/:id/ -> rendert Bild (width & height optional)
app.get('/uploads/img/:date/:id/', async (req, res) => {
  try {
    const date = req.params.date;
    const id = req.params.id;
    const publicPath = `/uploads/img/${date}/${id}/`;
    const entry = mappings[publicPath];
    if (!entry) return res.status(404).send('Nicht gefunden');

    const width = req.query.width ? parseInt(req.query.width) : null;
    const height = req.query.height ? parseInt(req.query.height) : null;

    // Validierung
    if ((width && (isNaN(width) || width <= 0)) || (height && (isNaN(height) || height <= 0))) {
      return res.status(400).send('Ungültige width/height Parameter');
    }

    // Pfade für Varianten
    const variantsDir = path.join(path.dirname(entry.localOriginalPath), 'variants');
    await fs.ensureDir(variantsDir);

    if (!width && !height) {
      // Original senden
      return res.sendFile(path.resolve(entry.localOriginalPath));
    }

    // Variant-Name
    const variantName = `w${width||''}_h${height||''}${entry.ext}`;
    const variantPath = path.join(variantsDir, variantName);

    if (await fs.pathExists(variantPath)) {
      return res.sendFile(path.resolve(variantPath));
    }

    // Variante erzeugen
    await sharp(entry.localOriginalPath)
      .resize(width || null, height || null, { fit: 'cover' })
      .toFile(variantPath);

    return res.sendFile(path.resolve(variantPath));
  } catch (err) {
    console.error(err);
    return res.status(500).send('Serverfehler: ' + (err.message || String(err)));
  }
});

// Debug: alle Uploads (sichtbar unter /__list_uploads)
app.get('/__list_uploads', (req, res) => {
  res.json(mappings);
});

app.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
  console.log(`Ändere BASE_URL in server.js, falls du eine öffentliche Domain verwendest.`);
});
