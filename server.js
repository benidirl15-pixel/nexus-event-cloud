// ═══════════════════════════════════════════════════════════
//  NEXUS EVENT APP — Serveur cloud permanent pour l'appel à communication
//
//  Contrairement au serveur intégré à l'application desktop (qui ne tourne
//  que lorsque le PC de l'organisateur est allumé), CE serveur est fait
//  pour être déployé chez un hébergeur (Render, Railway...) et tourner
//  24/7, indépendamment de l'ordinateur de l'organisateur.
//
//  Il ne contient AUCUNE base de données locale : tout passe par Supabase
//  (déjà utilisé par l'appli desktop pour la synchronisation cloud).
//  Voir README.md pour les instructions de déploiement complètes.
// ═══════════════════════════════════════════════════════════

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || 'communications-appel';
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Variables d\'environnement manquantes : SUPABASE_URL et SUPABASE_SERVICE_KEY sont obligatoires.');
  console.error('   Voir README.md pour la configuration sur Render.');
  process.exit(1);
}

function sbHeaders(extra = {}) {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra };
}

async function getAppelConfig(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/appels_publics?congres_id=eq.${congresId}&select=*&limit=1`, {
    headers: sbHeaders()
  });
  if (!res.ok) throw new Error(`Supabase (config) HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function insertDepot(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/depots_publics`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase (dépôt) HTTP ${res.status} — ${await res.text()}`);
}

async function uploadFileToStorage(buffer, remotePath, mimetype) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${remotePath}`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': mimetype || 'application/octet-stream', 'x-upsert': 'true' }),
    body: buffer
  });
  if (!res.ok) throw new Error(`Supabase (upload) HTTP ${res.status} — ${await res.text()}`);
  // URL publique (le bucket doit être configuré en accès public — voir README.md)
  return `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${remotePath}`;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function pageLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
         background:#0f172a; color:#e2e8f0; min-height:100vh; padding:24px 16px; }
  .wrap { max-width:640px; margin:0 auto; }
  .header { text-align:center; margin-bottom:28px; }
  .header h1 { font-size:22px; margin:12px 0 4px; background:linear-gradient(90deg,#00e5cc,#6c3fc5,#e040fb);
               -webkit-background-clip:text; background-clip:text; -webkit-text-fill-color:transparent; }
  .header p { color:#94a3b8; font-size:13px; margin:0; }
  .badge-open  { display:inline-block; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600;
                 background:rgba(16,185,129,.15); color:#34d399; border:1px solid rgba(16,185,129,.3); }
  .badge-closed{ display:inline-block; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600;
                 background:rgba(239,68,68,.15); color:#f87171; border:1px solid rgba(239,68,68,.3); }
  .card { background:#161f38; border:1px solid rgba(255,255,255,.08); border-radius:16px; padding:22px; margin-bottom:16px; }
  .card h2 { font-size:14px; margin:0 0 10px; color:#a78bfa; }
  .card p, .card div.txt { font-size:13.5px; line-height:1.6; color:#cbd5e1; white-space:pre-wrap; margin:0; }
  label { display:block; font-size:12.5px; color:#94a3b8; margin:14px 0 6px; font-weight:600; }
  input[type=text], input[type=email], select {
    width:100%; padding:11px 12px; border-radius:10px; border:1.5px solid rgba(255,255,255,.12);
    background:#0f172a; color:#e2e8f0; font-size:14px; }
  input[type=file] { width:100%; padding:10px; border-radius:10px; border:1.5px dashed rgba(255,255,255,.2);
    background:#0f172a; color:#94a3b8; font-size:13px; }
  button { width:100%; margin-top:22px; padding:14px; border:none; border-radius:12px; font-size:15px; font-weight:700;
    color:#fff; background:linear-gradient(90deg,#00e5cc,#6c3fc5); cursor:pointer; }
  .footer { text-align:center; color:#475569; font-size:11px; margin-top:20px; }
  .success { text-align:center; padding:50px 20px; }
  .success .icon { font-size:52px; margin-bottom:14px; }
  .success h1 { font-size:20px; color:#34d399; margin:0 0 10px; }
  .success p { color:#94a3b8; font-size:14px; }
</style></head>
<body><div class="wrap">${bodyHtml}</div></body></html>`;
}

const app = express();
app.set('trust proxy', 1); // nécessaire derrière le proxy de Render pour un rate-limit correct

const depotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Trop de dépôts envoyés depuis cette adresse. Réessayez plus tard.' },
  handler: (req, res) => res.status(429).send(pageLayout('Trop de requêtes', `
    <div class="success"><div class="icon">⏳</div><h1>Trop de dépôts envoyés</h1>
    <p>Merci de patienter avant de soumettre une nouvelle communication.</p></div>`))
});

const ALLOWED = {
  fichier_ppt: {
    ext: ['.ppt', '.pptx'],
    mime: ['application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
  },
  fichier_poster: {
    ext: ['.pdf', '.png', '.jpg', '.jpeg'],
    mime: ['application/pdf', 'image/png', 'image/jpeg']
  }
};

const upload = multer({
  storage: multer.memoryStorage(), // pas de disque local persistant sur Render — tout part vers Supabase Storage
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const rule = ALLOWED[file.fieldname];
    if (!rule) return cb(new Error('Champ de fichier inconnu'));
    const path = require('path');
    const ext = path.extname(file.originalname).toLowerCase();
    if (!rule.ext.includes(ext) || !rule.mime.includes(file.mimetype)) {
      return cb(new Error(`Type de fichier non autorisé (extensions acceptées : ${rule.ext.join(', ')})`));
    }
    cb(null, true);
  }
});

app.get('/', (req, res) => {
  res.send(pageLayout('NEXUS EVENT APP — Appel à communication', `
    <div class="header"><h1>🌿 NEXUS EVENT APP</h1><p>Serveur d'appel à communication</p></div>
    <div class="card" style="text-align:center">
      <div class="txt">Ce serveur est actif. Utilisez le lien fourni par l'organisateur de votre congrès,
      au format <code>/appel/VOTRE_NUMERO_DE_CONGRES</code>.</div>
    </div>
  `));
});

app.get('/appel/:congresId', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  try {
    const config = await getAppelConfig(congresId);
    if (!config) {
      return res.status(404).send(pageLayout('Introuvable', `
        <div class="success"><div class="icon">🔍</div><h1>Congrès introuvable</h1>
        <p>Aucun appel à communication n'est configuré pour ce lien. Vérifiez l'adresse fournie par l'organisateur.</p></div>`));
    }

    const today = new Date().toISOString().slice(0, 10);
    const isOpen = config.statut === 'ouvert' && (!config.date_limite || today <= config.date_limite);

    if (!isOpen) {
      return res.send(pageLayout(config.congres_nom, `
        <div class="header"><h1>${escapeHtml(config.congres_nom)}</h1><p>Appel à communication</p></div>
        <div class="card" style="text-align:center">
          <span class="badge-closed">🔴 Appel fermé</span>
          <p style="margin-top:14px">Les dépôts ne sont plus acceptés pour ce congrès pour le moment.</p>
        </div>
      `));
    }

    res.send(pageLayout(config.congres_nom, `
      <div class="header">
        <h1>${escapeHtml(config.congres_nom)}</h1>
        <p>Appel à communication</p>
        <div style="margin-top:8px"><span class="badge-open">🟢 Appel ouvert</span></div>
      </div>
      ${config.criteres ? `<div class="card"><h2>📋 Critères de soumission</h2><div class="txt">${escapeHtml(config.criteres)}</div></div>` : ''}
      ${config.instructions_ppt ? `<div class="card"><h2>📊 Instructions PowerPoint</h2><div class="txt">${escapeHtml(config.instructions_ppt)}</div></div>` : ''}
      ${config.instructions_poster ? `<div class="card"><h2>🖼️ Instructions e-poster</h2><div class="txt">${escapeHtml(config.instructions_poster)}</div></div>` : ''}
      ${config.date_limite ? `<div class="card"><h2>⏰ Date limite</h2><div class="txt">${escapeHtml(config.date_limite)}</div></div>` : ''}

      <div class="card">
        <h2>📝 Déposer une communication</h2>
        <form method="POST" action="/appel/${congresId}" enctype="multipart/form-data">
          <label>Titre de la communication *</label>
          <input type="text" name="titre" required maxlength="500">
          <label>Auteur *</label>
          <input type="text" name="auteur" required maxlength="300">
          <label>Email *</label>
          <input type="email" name="email" required maxlength="200">
          <label>Type de présentation</label>
          <select name="type_presentation">
            <option value="orale">Orale</option>
            <option value="poster">Poster</option>
          </select>
          <label>Fichier PowerPoint (.ppt/.pptx)</label>
          <input type="file" name="fichier_ppt" accept=".ppt,.pptx">
          <label>E-poster (.pdf/.png/.jpg)</label>
          <input type="file" name="fichier_poster" accept=".pdf,.png,.jpg,.jpeg">
          <button type="submit">Envoyer ma communication</button>
        </form>
      </div>
      <div class="footer">${config.contact_email ? 'Contact : ' + escapeHtml(config.contact_email) : ''}</div>
    `));
  } catch (e) {
    console.error('[GET /appel]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur serveur</h1><p>Merci de réessayer dans quelques instants.</p></div>`));
  }
});

app.post('/appel/:congresId', depotLimiter, (req, res, next) => {
  upload.fields([{ name: 'fichier_ppt', maxCount: 1 }, { name: 'fichier_poster', maxCount: 1 }])(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux (30 Mo maximum).' : (err.message || 'Fichier invalide.');
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Dépôt refusé</h1><p>${escapeHtml(msg)}</p></div>`));
    }
    next();
  });
}, async (req, res) => {
  try {
    const congresId = parseInt(req.params.congresId);
    const config = await getAppelConfig(congresId);
    if (!config) {
      return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Congrès introuvable</h1></div>`));
    }

    const { titre, auteur, email, type_presentation } = req.body;
    if (!titre || !auteur || !email) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Champs manquants</h1><p>Titre, auteur et email sont obligatoires.</p></div>`));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Email invalide</h1><p>Veuillez saisir une adresse email valide.</p></div>`));
    }
    if (titre.length > 500 || auteur.length > 300) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Champ trop long</h1><p>Merci de raccourcir votre saisie.</p></div>`));
    }

    let pptUrl = null, posterUrl = null;
    const stamp = Date.now();
    if (req.files?.fichier_ppt?.[0]) {
      const f = req.files.fichier_ppt[0];
      pptUrl = await uploadFileToStorage(f.buffer, `${congresId}/${stamp}_${f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`, f.mimetype);
    }
    if (req.files?.fichier_poster?.[0]) {
      const f = req.files.fichier_poster[0];
      posterUrl = await uploadFileToStorage(f.buffer, `${congresId}/${stamp}_${f.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`, f.mimetype);
    }

    await insertDepot({
      congres_id: congresId,
      titre, auteur, email,
      type_presentation: type_presentation === 'poster' ? 'poster' : 'orale',
      fichier_ppt_url: pptUrl,
      fichier_poster_url: posterUrl,
      synced: false
    });

    res.send(pageLayout('Merci', `
      <div class="success">
        <div class="icon">✅</div>
        <h1>Communication reçue !</h1>
        <p>Merci <strong>${escapeHtml(auteur)}</strong>, votre communication « ${escapeHtml(titre)} »
        a bien été enregistrée pour <strong>${escapeHtml(config.congres_nom)}</strong>.<br>
        Elle sera examinée prochainement par l'organisateur.</p>
      </div>
    `));
  } catch (e) {
    console.error('[POST /appel]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

// ── Inscription publique des participants ───────────────────────────────
async function getInscriptionConfig(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/inscriptions_publiques_config?congres_id=eq.${congresId}&select=*&limit=1`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase (config inscription) HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}
async function getTarifsPublics(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/tarifs_publics?congres_id=eq.${congresId}&select=*&order=montant.asc`, { headers: sbHeaders() });
  if (!res.ok) return [];
  return res.json();
}
async function insertInscription(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/inscriptions_recues`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase (inscription) HTTP ${res.status} — ${await res.text()}`);
}

const inscriptionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: "Trop d'inscriptions envoyées depuis cette adresse. Réessayez plus tard." },
  handler: (req, res) => res.status(429).send(pageLayout('Trop de requêtes', `
    <div class="success"><div class="icon">⏳</div><h1>Trop d'inscriptions envoyées</h1><p>Merci de patienter.</p></div>`))
});

app.get('/inscription/:congresId', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  try {
    const config = await getInscriptionConfig(congresId);
    if (!config) {
      return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Congrès introuvable</h1></div>`));
    }
    const today = new Date().toISOString().slice(0, 10);
    const isOpen = config.statut === 'ouvert' && (!config.date_limite || today <= config.date_limite);
    if (!isOpen) {
      return res.send(pageLayout(config.congres_nom, `
        <div class="header"><h1>${escapeHtml(config.congres_nom)}</h1><p>Inscription des participants</p></div>
        <div class="card" style="text-align:center"><span class="badge-closed">🔴 Inscriptions fermées</span></div>`));
    }
    const tarifs = await getTarifsPublics(congresId);
    const fmtMontant = (m, d) => `${Number(m).toLocaleString('fr-FR')} ${d || 'DZD'}`;

    res.send(pageLayout(config.congres_nom, `
      <div class="header">
        <h1>${escapeHtml(config.congres_nom)}</h1><p>Inscription des participants</p>
        <div style="margin-top:8px"><span class="badge-open">🟢 Inscriptions ouvertes</span></div>
      </div>
      ${config.message_bienvenue ? `<div class="card"><div class="txt">${escapeHtml(config.message_bienvenue)}</div></div>` : ''}
      ${config.date_limite ? `<div class="card"><h2>⏰ Date limite</h2><div class="txt">${escapeHtml(config.date_limite)}</div></div>` : ''}
      ${tarifs.length ? `<div class="card"><h2>💶 Tarifs</h2><div class="txt">${tarifs.map(t => `${escapeHtml(t.libelle)} (${escapeHtml(t.type_participant)}) — <strong>${fmtMontant(t.montant, t.devise)}</strong>`).join('<br>')}</div></div>` : ''}
      <div class="card">
        <h2>📝 S'inscrire au congrès</h2>
        <form method="POST" action="/inscription/${congresId}">
          <label>Prénom *</label><input type="text" name="prenom" required maxlength="100">
          <label>Nom *</label><input type="text" name="nom" required maxlength="100">
          <label>Email *</label><input type="email" name="email" required maxlength="200">
          <label>Téléphone</label><input type="text" name="telephone" maxlength="20">
          <label>Institution / Organisme</label><input type="text" name="institution" maxlength="200">
          <label>Spécialité</label><input type="text" name="specialite" maxlength="150">
          <label>Type de participation</label>
          <select name="type_participant">
            <option value="participant">Participant</option>
            <option value="intervenant">Intervenant</option>
            <option value="presse">Presse</option>
          </select>
          ${tarifs.length ? `<label>Tarif</label><select name="categorie"><option value="">-- Aucun --</option>${tarifs.map(t => `<option value="${escapeHtml(t.libelle)}">${escapeHtml(t.libelle)} — ${fmtMontant(t.montant, t.devise)}</option>`).join('')}</select>` : ''}
          <label>Régime alimentaire particulier</label><input type="text" name="regime_alimentaire" maxlength="150">
          <button type="submit">M'inscrire</button>
        </form>
      </div>
      <div class="footer">${config.contact_email ? 'Contact : ' + escapeHtml(config.contact_email) : ''}</div>
    `));
  } catch (e) {
    console.error('[GET /inscription]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur serveur</h1></div>`));
  }
});

app.post('/inscription/:congresId', inscriptionLimiter, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const congresId = parseInt(req.params.congresId);
    const config = await getInscriptionConfig(congresId);
    if (!config) return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Congrès introuvable</h1></div>`));

    const { prenom, nom, email, telephone, institution, specialite, type_participant, categorie, regime_alimentaire } = req.body;
    if (!prenom || !nom || !email) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Champs manquants</h1><p>Prénom, nom et email sont obligatoires.</p></div>`));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Email invalide</h1></div>`));
    }
    if (prenom.length > 100 || nom.length > 100) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Champ trop long</h1></div>`));
    }
    const typeOk = ['participant', 'intervenant', 'presse'].includes(type_participant) ? type_participant : 'participant';

    await insertInscription({
      congres_id: congresId, prenom, nom, email, telephone: telephone || '', institution: institution || '',
      specialite: specialite || '', type_participant: typeOk, categorie: categorie || '',
      regime_alimentaire: regime_alimentaire || '', synced: false
    });

    res.send(pageLayout('Merci', `
      <div class="success"><div class="icon">✅</div><h1>Inscription reçue !</h1>
      <p>Merci <strong>${escapeHtml(prenom)} ${escapeHtml(nom)}</strong>, votre inscription à <strong>${escapeHtml(config.congres_nom)}</strong>
      a bien été enregistrée. Elle sera confirmée prochainement.</p></div>
    `));
  } catch (e) {
    console.error('[POST /inscription]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

// ── Espace partenaires (sponsors/exposants) ─────────────────────────────
async function getPartenairesConfig(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/partenaires_config?congres_id=eq.${congresId}&select=*&limit=1`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase (config partenaires) HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}
async function insertPartenaire(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/partenaires_recus`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase (partenaire) HTTP ${res.status} — ${await res.text()}`);
}

const uploadLogo = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const path = require('path');
    const ext = path.extname(file.originalname).toLowerCase();
    const okExt = ['.png', '.jpg', '.jpeg'].includes(ext);
    const okMime = ['image/png', 'image/jpeg'].includes(file.mimetype);
    if (!okExt || !okMime) return cb(new Error('Le logo doit être une image PNG ou JPEG.'));
    cb(null, true);
  }
});

const partenairesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Trop de dépôts envoyés depuis cette adresse. Réessayez plus tard.' },
  handler: (req, res) => res.status(429).send(pageLayout('Trop de requêtes', `
    <div class="success"><div class="icon">⏳</div><h1>Trop de dépôts envoyés</h1></div>`))
});

app.get('/partenaires/:congresId', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  try {
    const config = await getPartenairesConfig(congresId);
    if (!config) return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Congrès introuvable</h1></div>`));

    const today = new Date().toISOString().slice(0, 10);
    const isOpen = config.statut === 'ouvert' && (!config.date_limite || today <= config.date_limite);
    if (!isOpen) {
      return res.send(pageLayout(config.congres_nom, `
        <div class="header"><h1>${escapeHtml(config.congres_nom)}</h1><p>Espace partenaires</p></div>
        <div class="card" style="text-align:center"><span class="badge-closed">🔴 Dépôts fermés</span></div>`));
    }

    res.send(pageLayout(config.congres_nom, `
      <div class="header">
        <h1>${escapeHtml(config.congres_nom)}</h1><p>Espace partenaires — Sponsors & Exposants</p>
        <div style="margin-top:8px"><span class="badge-open">🟢 Dépôts ouverts</span></div>
      </div>
      ${config.message_bienvenue ? `<div class="card"><div class="txt">${escapeHtml(config.message_bienvenue)}</div></div>` : ''}
      <div class="card">
        <h2>🤝 Devenir partenaire</h2>
        <form method="POST" action="/partenaires/${congresId}" enctype="multipart/form-data">
          <label>Vous êtes *</label>
          <select name="type_partenaire"><option value="sponsor">Sponsor</option><option value="exposant">Exposant</option></select>
          <label>Nom de l'entreprise *</label><input type="text" name="entreprise" required maxlength="200">
          <label>Secteur d'activité</label><input type="text" name="secteur" maxlength="150">
          <label>Nom du contact *</label><input type="text" name="contact_nom" required maxlength="150">
          <label>Email du contact *</label><input type="email" name="contact_email" required maxlength="200">
          <label>Téléphone du contact</label><input type="text" name="contact_tel" maxlength="20">
          <label>Produits / services présentés</label><input type="text" name="produits" maxlength="300">
          <label>Logo de l'entreprise (PNG/JPEG, 5 Mo max)</label><input type="file" name="logo" accept=".png,.jpg,.jpeg">
          <button type="submit">Envoyer ma demande</button>
        </form>
      </div>
      <div class="footer">${config.contact_email ? 'Contact : ' + escapeHtml(config.contact_email) : ''}</div>
    `));
  } catch (e) {
    console.error('[GET /partenaires]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur serveur</h1></div>`));
  }
});

app.post('/partenaires/:congresId', partenairesLimiter, (req, res, next) => {
  uploadLogo.single('logo')(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Logo trop volumineux (5 Mo maximum).' : (err.message || 'Fichier invalide.');
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Dépôt refusé</h1><p>${escapeHtml(msg)}</p></div>`));
    }
    next();
  });
}, async (req, res) => {
  try {
    const congresId = parseInt(req.params.congresId);
    const config = await getPartenairesConfig(congresId);
    if (!config) return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Congrès introuvable</h1></div>`));

    const { type_partenaire, entreprise, secteur, contact_nom, contact_email, contact_tel, produits } = req.body;
    if (!entreprise || !contact_nom || !contact_email) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Champs manquants</h1></div>`));
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact_email)) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>Email invalide</h1></div>`));
    }

    let logoUrl = null;
    if (req.file) {
      logoUrl = await uploadFileToStorage(req.file.buffer, `logos/${congresId}/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`, req.file.mimetype);
    }

    await insertPartenaire({
      congres_id: congresId, type_partenaire: type_partenaire === 'exposant' ? 'exposant' : 'sponsor',
      entreprise, secteur: secteur || '', produits: produits || '', contact_nom, contact_email,
      contact_tel: contact_tel || '', logo_url: logoUrl, synced: false
    });

    res.send(pageLayout('Merci', `
      <div class="success"><div class="icon">✅</div><h1>Demande envoyée !</h1>
      <p>Merci <strong>${escapeHtml(entreprise)}</strong>, votre demande pour <strong>${escapeHtml(config.congres_nom)}</strong> a bien été reçue.</p></div>
    `));
  } catch (e) {
    console.error('[POST /partenaires]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

// ── Paiement en ligne (mode test tant qu'aucun vrai SATIM n'est branché) ──
async function getPaiementConfig(factureId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/paiements_config?facture_id=eq.${factureId}&select=*&limit=1`, { headers: sbHeaders() });
  if (!res.ok) throw new Error(`Supabase (config paiement) HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}
async function insertPaiementRecu(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/paiements_recus`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase (paiement) HTTP ${res.status} — ${await res.text()}`);
}

const paiementLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Trop de tentatives de paiement depuis cette adresse.' },
  handler: (req, res) => res.status(429).send(pageLayout('Trop de requêtes', `
    <div class="success"><div class="icon">⏳</div><h1>Trop de tentatives</h1></div>`))
});

app.get('/paiement/:factureId', async (req, res) => {
  const factureId = parseInt(req.params.factureId);
  try {
    const config = await getPaiementConfig(factureId);
    if (!config) return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Facture introuvable</h1></div>`));

    res.send(pageLayout('Paiement en ligne', `
      <div class="header"><h1>${escapeHtml(config.congres_nom)}</h1><p>Paiement en ligne</p></div>
      <div class="card">
        <h2>🧾 Facture ${escapeHtml(config.numero_facture)}</h2>
        <div class="txt">Participant : <strong>${escapeHtml(config.participant_nom)}</strong></div>
        <div class="txt">Montant restant dû : <strong>${Number(config.montant_restant).toLocaleString('fr-FR')} ${escapeHtml(config.devise || 'DZD')}</strong></div>
      </div>
      <div class="card" style="border:1px dashed #f59e0b">
        <div class="txt">⚠️ <strong>Mode test</strong> — aucun compte marchand SATIM/CIB n'est encore configuré.</div>
        <form method="POST" action="/paiement/${factureId}/simuler" style="margin-top:14px">
          <input type="hidden" name="resultat" value="reussi">
          <button type="submit" style="background:#16a34a">✅ Simuler un paiement réussi</button>
        </form>
        <form method="POST" action="/paiement/${factureId}/simuler" style="margin-top:10px">
          <input type="hidden" name="resultat" value="echoue">
          <button type="submit" style="background:#dc2626">❌ Simuler un paiement échoué</button>
        </form>
      </div>
    `));
  } catch (e) {
    console.error('[GET /paiement]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur serveur</h1></div>`));
  }
});

app.post('/paiement/:factureId/simuler', paiementLimiter, express.urlencoded({ extended: true }), async (req, res) => {
  try {
    const factureId = parseInt(req.params.factureId);
    const config = await getPaiementConfig(factureId);
    if (!config) return res.status(404).send(pageLayout('Introuvable', `<div class="success"><div class="icon">🔍</div><h1>Facture introuvable</h1></div>`));

    const resultat = req.body.resultat === 'reussi' ? 'reussi' : 'echoue';
    const reference = `TEST-${Date.now()}`;

    await insertPaiementRecu({
      facture_id: factureId, montant: config.montant_restant, statut: resultat,
      reference_transaction: reference, synced: false
    });

    if (resultat === 'reussi') {
      res.send(pageLayout('Paiement réussi', `<div class="success"><div class="icon">✅</div><h1>Paiement effectué (mode test)</h1><p>Référence : ${escapeHtml(reference)}</p></div>`));
    } else {
      res.send(pageLayout('Paiement échoué', `<div class="success"><div class="icon">❌</div><h1>Paiement échoué (simulation)</h1></div>`));
    }
  } catch (e) {
    console.error('[POST /paiement/simuler]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur cloud NEXUS EVENT APP démarré sur le port ${PORT} (appel, inscription, partenaires, paiement)`);
});
