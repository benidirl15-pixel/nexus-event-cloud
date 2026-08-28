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

// SMTP pour la confirmation automatique d'inscription (optionnel — si absent, l'inscription
// fonctionne quand même, simplement sans email automatique). Variables à définir sur Render/Railway.
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = process.env.SMTP_PORT || '587';
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ Variables d\'environnement manquantes : SUPABASE_URL et SUPABASE_SERVICE_KEY sont obligatoires.');
  console.error('   Voir README.md pour la configuration sur Render.');
  process.exit(1);
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.warn('⚠️  SMTP non configuré (SMTP_HOST/SMTP_USER/SMTP_PASS) — les emails de confirmation d\'inscription ne seront pas envoyés automatiquement.');
}

function sbHeaders(extra = {}) {
  return { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, ...extra };
}

// Réutilise la même logique que le serveur local (main.js) — best-effort, ne bloque jamais l'inscription.
async function envoyerEmailConfirmationInscription(destinataire, d, congresNom) {
  try {
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return;
    const nodemailer = require('nodemailer');
    const t = nodemailer.createTransport({
      host: SMTP_HOST, port: parseInt(SMTP_PORT) || 587, secure: SMTP_PORT == 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS }
    });
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#16262B">
        <div style="background:#1B4B5A;color:#fff;padding:20px 24px;border-radius:12px 12px 0 0">
          <h2 style="margin:0;font-size:18px">${escapeHtml(congresNom)}</h2>
          <p style="margin:4px 0 0;font-size:13px;color:#C8DAD9">Confirmation d'inscription</p>
        </div>
        <div style="background:#fff;border:1px solid #DFE6E4;border-top:none;padding:22px 24px;border-radius:0 0 12px 12px">
          <p>Bonjour <strong>${escapeHtml(d.prenom)} ${escapeHtml(d.nom)}</strong>,</p>
          <p>Votre inscription au congrès <strong>${escapeHtml(congresNom)}</strong> a bien été enregistrée. Elle sera confirmée prochainement par l'équipe d'organisation.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13.5px">
            <tr><td style="padding:6px 0;color:#54666C">Formule</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(d.formule || '—')}</td></tr>
            ${d.montant_total ? `<tr><td style="padding:6px 0;color:#54666C">Montant total</td><td style="padding:6px 0;text-align:right;font-weight:600">${Number(d.montant_total).toLocaleString('fr-FR')} DZD</td></tr>` : ''}
            ${d.accompagnateur === 'Oui' ? `<tr><td style="padding:6px 0;color:#54666C">Accompagnateur</td><td style="padding:6px 0;text-align:right;font-weight:600">${escapeHtml(d.accomp_nom || 'Oui')}</td></tr>` : ''}
          </table>
          <p style="font-size:13.5px">
            ${d.virement_effectue === 'Oui'
              ? "N'oubliez pas d'envoyer votre justificatif de virement à l'adresse de contact indiquée sur la page d'inscription du congrès."
              : "Merci d'effectuer votre virement bancaire dans un délai de 10 jours suivant cette inscription."}
          </p>
          <p style="font-size:12px;color:#8b84a8;margin-top:20px">Cet email a été envoyé automatiquement suite à votre inscription en ligne.</p>
        </div>
      </div>
    `;
    await t.sendMail({ from: SMTP_FROM || SMTP_USER, to: destinataire, subject: `Confirmation d'inscription — ${congresNom}`, html });
  } catch (e) {
    console.error('[Email confirmation inscription]', e.message);
  }
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

// ── Authentification légère pour l'accès organisateurs distant (page Programme) ──
const crypto = require('crypto');
// Secret stable pour ce déploiement, dérivé de la clé de service (déjà secrète et fixe).
const SESSION_SECRET = crypto.createHash('sha256').update(SUPABASE_SERVICE_KEY + ':session').digest('hex');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(pw, salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(check, 'hex')); }
  catch { return false; }
}
function signSessionToken(congresId) {
  const expiry = Date.now() + 1000 * 60 * 60 * 24 * 7; // 7 jours
  const payload = `${congresId}.${expiry}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}
function verifySessionToken(token, congresId) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [cid, expiry, sig] = parts;
  if (cid !== String(congresId)) return false;
  if (Date.now() > parseInt(expiry, 10)) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${cid}.${expiry}`).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  const match = header.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? decodeURIComponent(match.split('=').slice(1).join('=')) : null;
}


function pageLayout(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#FAFBF9; --surface:#FFFFFF; --ink:#16262B; --ink-soft:#54666C;
    --primary:#1B4B5A; --primary-dark:#0F323C; --accent:#2E8B74; --accent-soft:#E4F1EC;
    --warm:#C08A3E; --warm-soft:#F7EEDD; --border:#DFE6E4; --error:#C1443D; --error-soft:#FBEAE8;
  }
  *{box-sizing:border-box}
  body{margin:0;font-family:'Inter',-apple-system,sans-serif;background:var(--bg);color:var(--ink);min-height:100vh;padding:24px 0 60px}
  .wrap{max-width:640px;margin:0 auto;padding:0 16px}
  .header{background:linear-gradient(160deg,var(--primary) 0%,var(--primary-dark) 100%);color:#fff;
    padding:28px 22px;border-radius:16px;text-align:center;margin-bottom:24px}
  .header h1{font-family:'Space Grotesk',sans-serif;font-size:22px;margin:0 0 4px;letter-spacing:-.01em}
  .header p{color:#C8DAD9;margin:0;font-size:13.5px}
  .badge-open{display:inline-block;padding:5px 13px;border-radius:100px;font-size:12px;font-weight:600;background:rgba(255,255,255,.15);color:#CFE6DD;border:1px solid rgba(255,255,255,.25);margin-top:10px}
  .badge-closed{display:inline-block;padding:5px 13px;border-radius:100px;font-size:12px;font-weight:600;background:var(--error-soft);color:var(--error);border:1px solid #F3C9C5}
  .card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:22px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,38,43,.04),0 8px 24px rgba(16,38,43,.06)}
  .card h2{font-family:'Space Grotesk',sans-serif;font-size:15px;margin:0 0 10px;color:var(--primary)}
  .card p, .card div.txt{font-size:13.5px;line-height:1.6;color:var(--ink-soft);white-space:pre-wrap;margin:0}
  label{display:block;font-size:13px;font-weight:600;color:var(--ink);margin:16px 0 7px}
  label:first-of-type{margin-top:2px}
  .req{color:var(--warm);margin-left:2px}
  .opt-tag{font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:var(--ink-soft);background:#F1F4F3;padding:2px 7px;border-radius:5px;margin-left:6px;font-weight:500}
  .help{font-size:12px;color:var(--ink-soft);margin-top:6px}
  input[type=text],input[type=email],input[type=tel],input[type=date],input[type=number],select,textarea{
    width:100%;padding:11px 13px;border:1.5px solid var(--border);border-radius:9px;
    font-family:'Inter',sans-serif;font-size:14.5px;color:var(--ink);background:#fff}
  input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .radio-row{display:flex;flex-wrap:wrap;gap:9px;margin-top:2px}
  .radio-row label.opt{
    flex:1 1 auto;min-width:120px;display:flex;align-items:center;gap:8px;
    border:1.5px solid var(--border);border-radius:10px;padding:10px 14px;font-size:13.5px;
    font-weight:500;color:var(--ink-soft);cursor:pointer;background:#fff;margin:0}
  .radio-row input{width:15px;height:15px;accent-color:var(--accent);flex-shrink:0;margin:0}
  .radio-row label.opt:has(input:checked){border-color:var(--accent);background:var(--accent-soft);color:var(--ink)}
  .plan-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:2px}
  @media(max-width:480px){.plan-grid{grid-template-columns:1fr}}
  .plan{border:1.5px solid var(--border);border-radius:11px;padding:14px;cursor:pointer;background:#fff}
  .plan:has(input:checked){border-color:var(--primary);box-shadow:0 0 0 3px var(--accent-soft);background:#F9FCFB}
  .plan input{margin-right:7px;accent-color:var(--primary)}
  .plan-name{font-weight:600;font-size:13.5px;color:var(--ink);display:inline}
  .plan-inc{font-size:12px;color:var(--ink-soft);margin:6px 0 8px;line-height:1.4}
  .plan-price{font-family:'IBM Plex Mono',monospace;font-size:12.5px;font-weight:600;color:var(--primary)}
  .conditional{border-left:2.5px solid var(--accent-soft);padding-left:16px;margin-top:16px}
  .checkbox-line{display:flex;align-items:flex-start;gap:10px;padding:13px 15px;border:1.5px solid var(--border);border-radius:10px;margin-top:14px;background:#fff}
  .checkbox-line input{margin-top:2px;width:16px;height:16px;accent-color:var(--accent);flex-shrink:0}
  .checkbox-line span{font-size:13px;color:var(--ink)}
  .info-box{background:var(--warm-soft);border:1px solid #EAD9B5;border-radius:9px;padding:12px 14px;font-size:12.5px;color:#6B5223;margin-top:10px;line-height:1.5}
  button{width:100%;margin-top:22px;padding:14px;border:none;border-radius:11px;font-family:'Space Grotesk',sans-serif;
    font-size:15px;font-weight:600;color:#fff;background:var(--primary);cursor:pointer}
  button:hover{background:var(--primary-dark)}
  .footer{text-align:center;color:var(--ink-soft);font-size:11.5px;margin-top:20px}
  .success{text-align:center;padding:60px 20px 40px}
  .success .icon{width:56px;height:56px;border-radius:50%;background:var(--accent-soft);color:var(--accent);
    display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 16px}
  .success h1{font-family:'Space Grotesk',sans-serif;font-size:20px;color:var(--primary-dark);margin:0 0 10px}
  .success p{color:var(--ink-soft);font-size:14px;line-height:1.6}
  .alert{background:var(--error-soft);border:1px solid #F3C9C5;color:var(--error);border-radius:10px;padding:12px 14px;font-size:13px;margin-bottom:14px}
  .total-box{background:var(--primary-dark);color:#fff;border-radius:12px;padding:16px 18px;margin-top:18px;display:flex;justify-content:space-between;align-items:center}
  .total-box .label{font-size:12.5px;color:#9FC6BB}
  .total-box .val{font-family:'IBM Plex Mono',monospace;font-size:19px;font-weight:600;color:#5FD9AE}
</style></head>
<body><div class="wrap">${bodyHtml}</div></body></html>`;
}

// ─── Formulaire d'inscription public — 58 wilayas d'Algérie ──────────────
const WILAYAS = [
  "01 - Adrar","02 - Chlef","03 - Laghouat","04 - Oum El Bouaghi","05 - Batna","06 - Béjaïa",
  "07 - Biskra","08 - Béchar","09 - Blida","10 - Bouira","11 - Tamanrasset","12 - Tébessa",
  "13 - Tlemcen","14 - Tiaret","15 - Tizi Ouzou","16 - Alger","17 - Djelfa","18 - Jijel",
  "19 - Sétif","20 - Saïda","21 - Skikda","22 - Sidi Bel Abbès","23 - Annaba","24 - Guelma",
  "25 - Constantine","26 - Médéa","27 - Mostaganem","28 - M'Sila","29 - Mascara","30 - Ouargla",
  "31 - Oran","32 - El Bayadh","33 - Illizi","34 - Bordj Bou Arréridj","35 - Boumerdès",
  "36 - El Tarf","37 - Tindouf","38 - Tissemsilt","39 - El Oued","40 - Khenchela",
  "41 - Souk Ahras","42 - Tipaza","43 - Mila","44 - Aïn Defla","45 - Naâma","46 - Aïn Témouchent",
  "47 - Ghardaïa","48 - Relizane","49 - Timimoun","50 - Bordj Badji Mokhtar","51 - Ouled Djellal",
  "52 - Béni Abbès","53 - In Salah","54 - In Guezzam","55 - Touggourt","56 - Djanet",
  "57 - El M'Ghair","58 - El Meniaa"
];

// Construit le HTML du formulaire public d'inscription (21 champs).
// tarifsValides : lignes de `tarifs_publics` publiées par l'organisateur pour ce congrès.
// Les libellés contenant "accompagnateur" sont proposés comme formule accompagnateur ;
// les autres comme formule participant.
function buildInscriptionFormHtml(congresNom, config, tarifsValides, congresId) {
  // Formules à tarifs fixes (définies par l'organisation — plus besoin de configurer
  // le module Tarifs pour ce formulaire).
  const FORMULES = [
    { libelle: 'Congrès seul', inc: 'Accès aux séances scientifiques', prix: 1500 },
    { libelle: 'Tout compris', inc: 'Congrès + hébergement', prix: 4500 },
    { libelle: 'Étudiant', inc: 'Carte étudiante obligatoire', prix: 0, gratuit: true },
  ];
  const fmtMontant = (m) => m === 0 ? 'Gratuit' : `${Number(m).toLocaleString('fr-FR')} DA`;

  return `
    <div class="header">
      <h1>${escapeHtml(congresNom)}</h1>
      <p>Inscription des participants</p>
      <div><span class="badge-open">🟢 Inscriptions ouvertes</span></div>
    </div>

    ${config.message_bienvenue ? `<div class="card"><div class="txt">${escapeHtml(config.message_bienvenue)}</div></div>` : ''}
    ${config.date_limite ? `<div class="card"><h2>⏰ Date limite d'inscription</h2><div class="txt">${escapeHtml(config.date_limite)}</div></div>` : ''}

    <form method="POST" action="/inscription/${congresId}" id="fInscription">

      <div class="card">
        <h2>👤 Identité</h2>
        <label>Nom<span class="req">*</span></label>
        <input type="text" name="nom" required maxlength="100">
        <label>Prénom<span class="req">*</span></label>
        <input type="text" name="prenom" required maxlength="100">

        <label>Sexe<span class="req">*</span></label>
        <div class="radio-row">
          <label class="opt"><input type="radio" name="sexe" value="Masculin" required> Masculin</label>
          <label class="opt"><input type="radio" name="sexe" value="Féminin"> Féminin</label>
        </div>

        <label>Date de naissance<span class="req">*</span></label>
        <input type="date" name="date_naissance" required style="max-width:220px">
      </div>

      <div class="card">
        <h2>📞 Contact &amp; exercice</h2>
        <label>Numéro de téléphone<span class="req">*</span></label>
        <input type="tel" name="telephone" required maxlength="20" placeholder="05XX XX XX XX">
        <label>Adresse email<span class="req">*</span></label>
        <input type="email" name="email" required maxlength="200">
        <label>Wilaya d'exercice<span class="req">*</span></label>
        <select name="wilaya" required>
          <option value="" disabled selected>Sélectionnez votre wilaya</option>
          ${WILAYAS.map(w => `<option value="${w}">${w}</option>`).join('')}
        </select>
        <label>Lieu d'exercice<span class="req">*</span></label>
        <input type="text" name="lieu_exercice" required maxlength="200" placeholder="précisez votre ville / commune / établissement">
      </div>

      <div class="card">
        <h2>🩺 Spécialité</h2>
        <label>Spécialité<span class="req">*</span></label>
        <div class="radio-row" style="flex-direction:column">
          <label class="opt"><input type="radio" name="specialite" value="Médecin généraliste" required> Médecin généraliste</label>
          <label class="opt"><input type="radio" name="specialite" value="Médecin spécialiste" id="rb-specialiste"> Médecin spécialiste</label>
          <label class="opt"><input type="radio" name="specialite" value="Interne"> Interne</label>
          <label class="opt"><input type="radio" name="specialite" value="Résident"> Résident</label>
          <label class="opt"><input type="radio" name="specialite" value="Étudiant en médecine"> Étudiant en médecine</label>
          <label class="opt"><input type="radio" name="specialite" value="Autre"> Autre : <input type="text" name="specialite_autre" placeholder="précisez" style="width:140px;padding:6px 9px;font-size:12.5px;margin-left:6px"></label>
        </div>
        <div id="wrap-precision" style="display:none">
          <label>Si spécialiste, précisez votre spécialité<span class="opt-tag">optionnel</span></label>
          <input type="text" name="precision_specialite" maxlength="150" placeholder="ex : cardiologie, pédiatrie…">
        </div>
      </div>

      <div class="card">
        <h2>🎫 Choix de la formule</h2>
        <div class="plan-grid">
          ${FORMULES.map((f, i) => `
            <label class="plan">
              <input type="radio" name="formule" value="${escapeHtml(f.libelle)}" data-price="${f.prix}" ${i===0?'required':''}>
              <span class="plan-name">${escapeHtml(f.libelle)}</span>
              <div class="plan-inc">${escapeHtml(f.inc)}</div>
              <div class="plan-price">${fmtMontant(f.prix)}</div>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="card">
        <h2>🛏️ Hébergement</h2>
        <label>Souhaitez-vous partager votre chambre avec un(e) confrère / consœur en particulier ?<span class="req">*</span></label>
        <div class="radio-row">
          <label class="opt"><input type="radio" name="partage_chambre" value="Oui" id="rb-partage-oui" required> Oui</label>
          <label class="opt"><input type="radio" name="partage_chambre" value="Non" id="rb-partage-non"> Non</label>
        </div>
        <div class="conditional" id="wrap-partage" style="display:none">
          <label>Nom et prénom du compagnon / de la compagne de chambre</label>
          <input type="text" name="compagnon_chambre" maxlength="150">
          <div class="help">Les deux participants doivent impérativement indiquer le nom de l'autre sur leur formulaire respectif pour que la demande soit validée.</div>
        </div>
        <div class="info-box" id="wrap-partage-non" style="display:none">Veuillez noter qu'en l'absence de préférence exprimée, les organisateurs se réservent le droit d'attribuer un(e) compagnon / compagne de chambre selon les disponibilités et les profils des participants. Aucune réclamation ne pourra être formulée à ce titre.</div>
      </div>

      <div class="card">
        <h2>💳 Paiement</h2>
        <div id="total-recap" class="total-box" style="display:none">
          <span class="label">Montant total à régler</span>
          <span class="val" id="total-val">—</span>
        </div>
        <input type="hidden" name="montant_total" id="montant_total_input" value="">

        <label>Avez-vous effectué votre virement bancaire ?<span class="req">*</span></label>
        <div class="radio-row" style="flex-direction:column">
          <label class="opt"><input type="radio" name="virement_effectue" value="Oui" required> Oui — j'enverrai le justificatif${config.contact_email ? ` à ${escapeHtml(config.contact_email)}` : ''}</label>
          <label class="opt"><input type="radio" name="virement_effectue" value="Non"> Non — je m'engage à effectuer le virement dans un délai de 10 jours</label>
        </div>

        <label class="checkbox-line" style="cursor:pointer">
          <input type="checkbox" name="accept_conditions" required>
          <span>J'ai pris connaissance des conditions d'inscription, de paiement, d'hébergement et d'annulation. Oui, j'accepte<span class="req">*</span></span>
        </label>
        <label class="checkbox-line" style="cursor:pointer">
          <input type="checkbox" name="accept_certif" required>
          <span>Je certifie que les informations fournies sont exactes. Oui, je confirme<span class="req">*</span></span>
        </label>
      </div>

      <div class="card">
        <h2>🔒 Protection des données personnelles</h2>
        <p style="font-size:13px;color:var(--ink-soft);line-height:1.6;margin:0 0 12px">
          Les informations collectées dans ce formulaire sont utilisées exclusivement dans le cadre de l'organisation
          du <strong>${escapeHtml(congresNom)}</strong> et ne seront en aucun cas transmises à des tiers sans votre consentement.
          Conformément à la législation en vigueur, vous disposez d'un droit d'accès, de rectification et de suppression
          de vos données personnelles en envoyant votre demande à ${config.contact_email ? escapeHtml(config.contact_email) : "l'adresse de contact de l'organisation"}.
          En soumettant ce formulaire, vous acceptez que vos données soient traitées dans le cadre strict de cet événement.
        </p>
        <label class="checkbox-line" style="cursor:pointer">
          <input type="checkbox" name="accept_rgpd" required>
          <span>J'ai lu et j'accepte la politique de protection des données personnelles<span class="req">*</span></span>
        </label>
      </div>

      <button type="submit">M'inscrire</button>
    </form>
    <div class="footer">${config.contact_email ? 'Contact : ' + escapeHtml(config.contact_email) : ''}</div>

    <script>
      document.querySelectorAll('input[name="specialite"]').forEach(function(r){
        r.addEventListener('change', function(){
          document.getElementById('wrap-precision').style.display =
            (document.getElementById('rb-specialiste').checked) ? 'block' : 'none';
        });
      });
      document.querySelectorAll('input[name="partage_chambre"]').forEach(function(r){
        r.addEventListener('change', function(){
          document.getElementById('wrap-partage').style.display =
            (document.getElementById('rb-partage-oui').checked) ? 'block' : 'none';
          document.getElementById('wrap-partage-non').style.display =
            (document.getElementById('rb-partage-non').checked) ? 'block' : 'none';
        });
      });
      function updateTotal(){
        var total = 0, any = false;
        var formule = document.querySelector('input[name="formule"]:checked');
        if (formule && formule.dataset.price) { total += parseFloat(formule.dataset.price) || 0; any = true; }
        var box = document.getElementById('total-recap');
        var val = document.getElementById('total-val');
        document.getElementById('montant_total_input').value = any ? total : '';
        if (any) { box.style.display = 'flex'; val.textContent = total.toLocaleString('fr-FR') + ' DA'; }
        else { box.style.display = 'none'; }
      }
      document.querySelectorAll('input[name="formule"]').forEach(function(el){
        el.addEventListener('change', updateTotal);
      });
      updateTotal();
    </script>
  `;
}

// Valide et extrait les données du formulaire d'inscription public.
// Retourne { data } si tout est valide, ou { error: { title, message } } sinon.
function validateAndExtractInscription(body) {
  const {
    prenom, nom, sexe, date_naissance, email, telephone, wilaya, lieu_exercice,
    specialite, specialite_autre, precision_specialite,
    formule, partage_chambre, compagnon_chambre, montant_total, virement_effectue,
    accept_conditions, accept_certif, accept_rgpd
  } = body;

  if (!prenom || !nom || !email || !sexe || !date_naissance || !telephone || !wilaya || !lieu_exercice || !specialite) {
    return { error: { title: 'Champs manquants', message: "Merci de compléter tous les champs obligatoires (identité, contact, spécialité) avant de soumettre le formulaire." } };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: { title: 'Email invalide', message: 'Veuillez saisir une adresse email valide.' } };
  }
  if (prenom.length > 100 || nom.length > 100) {
    return { error: { title: 'Champ trop long', message: 'Le prénom et le nom sont limités à 100 caractères.' } };
  }
  if (!formule) {
    return { error: { title: 'Formule manquante', message: 'Merci de choisir une formule de participation.' } };
  }
  if (!partage_chambre) {
    return { error: { title: 'Champ manquant', message: 'Merci d\'indiquer si vous souhaitez partager votre chambre.' } };
  }
  if (!virement_effectue) {
    return { error: { title: 'Champ manquant', message: 'Merci d\'indiquer si vous avez effectué votre virement bancaire.' } };
  }
  if (!accept_conditions || !accept_certif) {
    return { error: { title: 'Conditions non acceptées', message: "Vous devez accepter les conditions d'inscription et certifier l'exactitude des informations pour continuer." } };
  }
  if (!accept_rgpd) {
    return { error: { title: 'Consentement requis', message: "Vous devez accepter la politique de protection des données personnelles pour continuer." } };
  }

  const specialiteFinale = specialite === 'Autre' && specialite_autre ? `Autre : ${specialite_autre}` : specialite;

  return {
    data: {
      prenom, nom, sexe, date_naissance, email, telephone: telephone || '', wilaya, lieu_exercice,
      specialite: specialiteFinale, precision_specialite: precision_specialite || '',
      formule,
      accompagnateur: '', accomp_nom: '', accomp_sexe: '', accomp_lien: '', accomp_formule: '',
      partage_chambre, compagnon_chambre: partage_chambre === 'Oui' ? (compagnon_chambre || '') : '',
      montant_total: (montant_total !== undefined && montant_total !== '' && !isNaN(parseFloat(montant_total))) ? parseFloat(montant_total) : null,
      virement_effectue
    }
  };
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

// ── Programme public (sessions + hôtels + transport) ────────────────────────
async function getSessionsPubliques(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions_publiques?congres_id=eq.${congresId}&select=*&order=date_session.asc,heure_debut.asc`, { headers: sbHeaders() });
  if (!res.ok) return [];
  return res.json();
}
async function getHotelsPublics(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/hotels_publics?congres_id=eq.${congresId}&select=*&order=nom.asc`, { headers: sbHeaders() });
  if (!res.ok) return [];
  return res.json();
}
async function getProgrammeConfig(congresId) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/programme_public_config?congres_id=eq.${congresId}&select=*&limit=1`, { headers: sbHeaders() });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows[0] || null;
}
async function insertSessionPublique(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions_publiques`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase (session) HTTP ${res.status} — ${await res.text()}`);
}
async function deleteSessionPublique(id, congresId) {
  await fetch(`${SUPABASE_URL}/rest/v1/sessions_publiques?id=eq.${id}&congres_id=eq.${congresId}`, { method: 'DELETE', headers: sbHeaders() });
}
async function insertHotelPublic(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/hotels_publics`, {
    method: 'POST', headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }), body: JSON.stringify(row)
  });
  if (!res.ok) throw new Error(`Supabase (hôtel) HTTP ${res.status} — ${await res.text()}`);
}
async function deleteHotelPublic(id, congresId) {
  await fetch(`${SUPABASE_URL}/rest/v1/hotels_publics?id=eq.${id}&congres_id=eq.${congresId}`, { method: 'DELETE', headers: sbHeaders() });
}
async function upsertProgrammeConfig(congresId, fields) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/programme_public_config`, {
    method: 'POST',
    headers: sbHeaders({ 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ congres_id: congresId, ...fields, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`Supabase (config programme) HTTP ${res.status} — ${await res.text()}`);
}

const TYPE_SESSION_LABELS = {
  conference: '🎤 Conférence', atelier: '🛠️ Atelier', poster: '📋 Poster',
  symposium: '🎓 Symposium', pause: '☕ Pause', autre: '📌 Autre'
};

function buildProgrammeHtml(congresNom, sessionsByDay, hotels, transportInfo, congresId, isOrganisateur) {
  const jours = Object.keys(sessionsByDay).sort();
  const fmtDate = (d) => { try { return new Date(d).toLocaleDateString('fr-FR', { weekday:'long', day:'2-digit', month:'long' }); } catch { return d; } };

  const tabsHtml = jours.map((j, i) => `<button type="button" class="jour-tab ${i===0?'active':''}" data-jour="${j}">${escapeHtml(fmtDate(j))}</button>`).join('');

  const panelsHtml = jours.map((j, i) => `
    <div class="jour-panel" data-jour="${j}" style="${i===0?'':'display:none'}">
      ${sessionsByDay[j].map(s => `
        <div class="session-item">
          <div class="session-heure">${escapeHtml(s.heure_debut)} – ${escapeHtml(s.heure_fin)}</div>
          <div class="session-body">
            <div class="session-titre">${escapeHtml(s.titre)}</div>
            <div class="session-meta">
              <span class="session-badge">${TYPE_SESSION_LABELS[s.type_session] || s.type_session}</span>
              ${s.salle ? `<span class="session-salle">📍 ${escapeHtml(s.salle)}</span>` : ''}
            </div>
            ${s.description ? `<div class="session-desc">${escapeHtml(s.description)}</div>` : ''}
          </div>
          ${isOrganisateur ? `
            <form method="POST" action="/organisateurs/${congresId}/session/${s.id}/delete" onsubmit="return confirm('Supprimer cette session ?')" style="margin:0">
              <button type="submit" class="btn-del" title="Supprimer">🗑️</button>
            </form>` : ''}
        </div>
      `).join('') || '<p class="empty-txt">Aucune session ce jour-là.</p>'}
    </div>
  `).join('');

  const hotelsHtml = hotels.map(h => `
    <div class="hotel-item">
      <div>
        <div class="hotel-nom">${escapeHtml(h.nom)}${h.categorie ? ` <span class="hotel-cat">${escapeHtml(h.categorie)}</span>` : ''}</div>
        ${h.adresse ? `<div class="hotel-detail">📍 ${escapeHtml(h.adresse)}${h.ville ? ', '+escapeHtml(h.ville) : ''}</div>` : ''}
        ${h.distance_lieu ? `<div class="hotel-detail">🚶 ${escapeHtml(h.distance_lieu)}</div>` : ''}
        ${h.telephone ? `<div class="hotel-detail">📞 ${escapeHtml(h.telephone)}</div>` : ''}
      </div>
      ${isOrganisateur ? `
        <form method="POST" action="/organisateurs/${congresId}/hotel/${h.id}/delete" onsubmit="return confirm('Supprimer cet hôtel ?')" style="margin:0">
          <button type="submit" class="btn-del" title="Supprimer">🗑️</button>
        </form>` : ''}
    </div>
  `).join('') || '<p class="empty-txt">Aucun hôtel renseigné pour le moment.</p>';

  return `
    <div class="header">
      <h1>${escapeHtml(congresNom)}</h1>
      <p>Programme, hébergement & transport</p>
      ${isOrganisateur ? `<div style="margin-top:10px"><a href="/organisateurs/${congresId}/logout" style="color:#C8DAD9;font-size:12.5px">Se déconnecter</a></div>` : ''}
    </div>

    <div class="card">
      <h2>🗓️ Programme</h2>
      ${jours.length ? `
        <div class="jour-tabs">${tabsHtml}</div>
        ${panelsHtml}
      ` : '<p class="empty-txt">Le programme n\'a pas encore été publié.</p>'}
      ${isOrganisateur ? `
        <div class="conditional" style="margin-top:16px">
          <h3 style="font-size:13.5px;margin:0 0 10px">➕ Ajouter une session</h3>
          <form method="POST" action="/organisateurs/${congresId}/session">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div><label>Date</label><input type="date" name="date_session" required></div>
              <div><label>Type</label>
                <select name="type_session">
                  ${Object.entries(TYPE_SESSION_LABELS).map(([v,l]) => `<option value="${v}">${l}</option>`).join('')}
                </select>
              </div>
              <div><label>Heure début</label><input type="time" name="heure_debut" required></div>
              <div><label>Heure fin</label><input type="time" name="heure_fin" required></div>
            </div>
            <label>Titre</label><input type="text" name="titre" required maxlength="200">
            <label>Salle<span class="opt-tag">optionnel</span></label><input type="text" name="salle" maxlength="100">
            <label>Description<span class="opt-tag">optionnel</span></label><textarea name="description" rows="2" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:9px;font-family:inherit"></textarea>
            <button type="submit" style="margin-top:12px">Ajouter au programme</button>
          </form>
        </div>` : ''}
    </div>

    <div class="card">
      <h2>🏨 Hébergement</h2>
      ${hotelsHtml}
      ${isOrganisateur ? `
        <div class="conditional" style="margin-top:16px">
          <h3 style="font-size:13.5px;margin:0 0 10px">➕ Ajouter un hôtel</h3>
          <form method="POST" action="/organisateurs/${congresId}/hotel">
            <label>Nom</label><input type="text" name="nom" required maxlength="150">
            <label>Catégorie<span class="opt-tag">optionnel</span></label><input type="text" name="categorie" placeholder="ex : 4 étoiles" maxlength="50">
            <label>Adresse<span class="opt-tag">optionnel</span></label><input type="text" name="adresse" maxlength="200">
            <label>Ville<span class="opt-tag">optionnel</span></label><input type="text" name="ville" maxlength="100">
            <label>Distance du lieu du congrès<span class="opt-tag">optionnel</span></label><input type="text" name="distance_lieu" placeholder="ex : 5 min à pied" maxlength="100">
            <label>Téléphone<span class="opt-tag">optionnel</span></label><input type="text" name="telephone" maxlength="30">
            <button type="submit" style="margin-top:12px">Ajouter l'hôtel</button>
          </form>
        </div>` : ''}
    </div>

    <div class="card">
      <h2>🚌 Transport</h2>
      ${isOrganisateur ? `
        <form method="POST" action="/organisateurs/${congresId}/transport">
          <textarea name="transport_info" rows="5" style="width:100%;padding:10px;border:1.5px solid var(--border);border-radius:9px;font-family:inherit">${escapeHtml(transportInfo || '')}</textarea>
          <button type="submit" style="margin-top:12px">Enregistrer</button>
        </form>
      ` : (transportInfo ? `<div class="txt" style="white-space:pre-wrap">${escapeHtml(transportInfo)}</div>` : '<p class="empty-txt">Aucune information de transport pour le moment.</p>')}
    </div>

    <style>
      .jour-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
      .jour-tab{padding:8px 14px;border:1.5px solid var(--border);border-radius:100px;background:#fff;font-size:12.5px;font-weight:600;color:var(--ink-soft);cursor:pointer;text-transform:capitalize}
      .jour-tab.active{background:var(--primary);color:#fff;border-color:var(--primary)}
      .session-item{display:flex;gap:14px;padding:12px 0;border-bottom:1px solid var(--border)}
      .session-item:last-child{border-bottom:none}
      .session-heure{flex-shrink:0;width:100px;font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--primary);font-weight:600;padding-top:2px}
      .session-body{flex:1}
      .session-titre{font-weight:600;font-size:14px;color:var(--ink)}
      .session-meta{display:flex;gap:10px;margin-top:4px;flex-wrap:wrap}
      .session-badge{font-size:11px;background:var(--accent-soft);color:var(--primary);padding:2px 9px;border-radius:100px;font-weight:600}
      .session-salle{font-size:11.5px;color:var(--ink-soft)}
      .session-desc{font-size:12.5px;color:var(--ink-soft);margin-top:5px}
      .hotel-item{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)}
      .hotel-item:last-child{border-bottom:none}
      .hotel-nom{font-weight:600;font-size:14px}
      .hotel-cat{font-size:11px;color:var(--ink-soft);font-weight:500}
      .hotel-detail{font-size:12px;color:var(--ink-soft);margin-top:3px}
      .empty-txt{font-size:13px;color:var(--ink-soft);font-style:italic}
      .btn-del{background:none;border:none;font-size:15px;cursor:pointer;opacity:.6;padding:4px}
      .btn-del:hover{opacity:1}
    </style>
    <script>
      document.querySelectorAll('.jour-tab').forEach(function(tab){
        tab.addEventListener('click', function(){
          document.querySelectorAll('.jour-tab').forEach(function(t){t.classList.remove('active')});
          document.querySelectorAll('.jour-panel').forEach(function(p){p.style.display='none'});
          tab.classList.add('active');
          document.querySelector('.jour-panel[data-jour="'+tab.dataset.jour+'"]').style.display='block';
        });
      });
    </script>
  `;
}

function buildOrganisateurLoginHtml(congresId, error, hasPassword) {
  return `
    <div class="header"><h1>Accès organisateurs</h1><p>Connexion requise</p></div>
    <div class="card">
      ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ''}
      ${!hasPassword ? `<p style="font-size:13px;color:var(--ink-soft);margin-bottom:14px">Aucun mot de passe n'est encore défini pour cet espace. Choisissez-en un maintenant — il sera demandé à chaque prochaine connexion.</p>` : ''}
      <form method="POST" action="/organisateurs/${congresId}/login">
        <label>${hasPassword ? 'Mot de passe' : 'Choisir un mot de passe'}</label>
        <input type="password" name="password" required minlength="4" autofocus>
        <button type="submit" style="margin-top:14px">${hasPassword ? 'Se connecter' : 'Définir et se connecter'}</button>
      </form>
    </div>
  `;
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
    res.send(pageLayout(config.congres_nom, buildInscriptionFormHtml(config.congres_nom, config, tarifs, congresId)));
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

    const result = validateAndExtractInscription(req.body);
    if (result.error) {
      return res.status(400).send(pageLayout('Erreur', `<div class="success"><div class="icon">⚠️</div><h1>${escapeHtml(result.error.title)}</h1><p>${escapeHtml(result.error.message)}</p></div>`));
    }
    const d = result.data;

    await insertInscription({
      congres_id: congresId, prenom: d.prenom, nom: d.nom, sexe: d.sexe, date_naissance: d.date_naissance,
      email: d.email, telephone: d.telephone, wilaya: d.wilaya, lieu_exercice: d.lieu_exercice, specialite: d.specialite,
      precision_specialite: d.precision_specialite, formule: d.formule, accompagnateur: d.accompagnateur,
      accomp_nom: d.accomp_nom, accomp_sexe: d.accomp_sexe, accomp_lien: d.accomp_lien, accomp_formule: d.accomp_formule,
      partage_chambre: d.partage_chambre, compagnon_chambre: d.compagnon_chambre, montant_total: d.montant_total,
      virement_effectue: d.virement_effectue, synced: false
    });

    envoyerEmailConfirmationInscription(d.email, d, config.congres_nom); // best-effort, ne bloque pas la réponse

    res.send(pageLayout('Merci', `
      <div class="success"><div class="icon">✅</div><h1>Inscription reçue !</h1>
      <p>Merci <strong>${escapeHtml(d.prenom)} ${escapeHtml(d.nom)}</strong>, votre inscription à <strong>${escapeHtml(config.congres_nom)}</strong>
      a bien été enregistrée. Elle sera confirmée prochainement.
      ${d.virement_effectue === 'Oui' ? '<br><br>N\'oubliez pas d\'envoyer votre justificatif de virement à l\'adresse de contact indiquée sur la page du congrès.' : '<br><br>Merci d\'effectuer votre virement dans les 10 jours suivant cette inscription.'}</p></div>
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

// ─── Programme public (lecture seule, sans mot de passe) ──────────────────
app.get('/programme/:congresId', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  try {
    const config = await getProgrammeConfig(congresId);
    const sessions = await getSessionsPubliques(congresId);
    const hotels = await getHotelsPublics(congresId);
    // Le nom du congrès est repris de la config d'inscription publiée (déjà poussée par l'app)
    const inscConfig = await getInscriptionConfig(congresId);
    const congresNom = inscConfig?.congres_nom || `Congrès #${congresId}`;

    const sessionsByDay = {};
    sessions.forEach(s => { (sessionsByDay[s.date_session] = sessionsByDay[s.date_session] || []).push(s); });

    res.send(pageLayout(congresNom, buildProgrammeHtml(congresNom, sessionsByDay, hotels, config?.transport_info, congresId, false)));
  } catch (e) {
    console.error('[GET /programme]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur serveur</h1></div>`));
  }
});

// ─── Accès organisateurs (protégé par mot de passe, lecture + édition) ────
app.get('/organisateurs/:congresId', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  try {
    const config = await getProgrammeConfig(congresId);
    const token = getCookie(req, `orga_${congresId}`);
    const authed = verifySessionToken(token, congresId);

    if (!authed) {
      return res.send(pageLayout('Accès organisateurs', buildOrganisateurLoginHtml(congresId, null, !!(config && config.mot_de_passe_hash))));
    }

    const sessions = await getSessionsPubliques(congresId);
    const hotels = await getHotelsPublics(congresId);
    const inscConfig = await getInscriptionConfig(congresId);
    const congresNom = inscConfig?.congres_nom || `Congrès #${congresId}`;
    const sessionsByDay = {};
    sessions.forEach(s => { (sessionsByDay[s.date_session] = sessionsByDay[s.date_session] || []).push(s); });

    res.send(pageLayout(congresNom, buildProgrammeHtml(congresNom, sessionsByDay, hotels, config?.transport_info, congresId, true)));
  } catch (e) {
    console.error('[GET /organisateurs]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur serveur</h1></div>`));
  }
});

app.post('/organisateurs/:congresId/login', express.urlencoded({ extended: true }), async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  try {
    const { password } = req.body;
    if (!password || password.length < 4) {
      return res.send(pageLayout('Accès organisateurs', buildOrganisateurLoginHtml(congresId, 'Le mot de passe doit contenir au moins 4 caractères.', false)));
    }
    const config = await getProgrammeConfig(congresId);

    if (!config || !config.mot_de_passe_hash) {
      await upsertProgrammeConfig(congresId, { mot_de_passe_hash: hashPassword(password) });
    } else if (!verifyPassword(password, config.mot_de_passe_hash)) {
      return res.send(pageLayout('Accès organisateurs', buildOrganisateurLoginHtml(congresId, 'Mot de passe incorrect.', true)));
    }

    const token = signSessionToken(congresId);
    res.setHeader('Set-Cookie', `orga_${congresId}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${60*60*24*7}; SameSite=Lax`);
    res.redirect(`/organisateurs/${congresId}`);
  } catch (e) {
    console.error('[POST /organisateurs/login]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

app.get('/organisateurs/:congresId/logout', (req, res) => {
  const congresId = parseInt(req.params.congresId);
  res.setHeader('Set-Cookie', `orga_${congresId}=; HttpOnly; Path=/; Max-Age=0`);
  res.redirect(`/programme/${congresId}`);
});

function requireOrganisateurCloud(req, res, congresId) {
  const token = getCookie(req, `orga_${congresId}`);
  if (!verifySessionToken(token, congresId)) { res.redirect(`/organisateurs/${congresId}`); return false; }
  return true;
}

app.post('/organisateurs/:congresId/session', express.urlencoded({ extended: true }), async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  if (!requireOrganisateurCloud(req, res, congresId)) return;
  try {
    const { titre, type_session, date_session, heure_debut, heure_fin, salle, description } = req.body;
    if (titre && date_session && heure_debut && heure_fin) {
      await insertSessionPublique({
        congres_id: congresId, titre, description: description || null,
        type_session: type_session || 'conference', date_session, heure_debut, heure_fin, salle: salle || null
      });
    }
    res.redirect(`/organisateurs/${congresId}`);
  } catch (e) {
    console.error('[POST /organisateurs/session]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

app.post('/organisateurs/:congresId/session/:sessionId/delete', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  if (!requireOrganisateurCloud(req, res, congresId)) return;
  await deleteSessionPublique(parseInt(req.params.sessionId), congresId);
  res.redirect(`/organisateurs/${congresId}`);
});

app.post('/organisateurs/:congresId/hotel', express.urlencoded({ extended: true }), async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  if (!requireOrganisateurCloud(req, res, congresId)) return;
  try {
    const { nom, categorie, adresse, ville, distance_lieu, telephone } = req.body;
    if (nom) {
      await insertHotelPublic({
        congres_id: congresId, nom, categorie: categorie || null, adresse: adresse || null,
        ville: ville || null, distance_lieu: distance_lieu || null, telephone: telephone || null
      });
    }
    res.redirect(`/organisateurs/${congresId}`);
  } catch (e) {
    console.error('[POST /organisateurs/hotel]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

app.post('/organisateurs/:congresId/hotel/:hotelId/delete', async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  if (!requireOrganisateurCloud(req, res, congresId)) return;
  await deleteHotelPublic(parseInt(req.params.hotelId), congresId);
  res.redirect(`/organisateurs/${congresId}`);
});

app.post('/organisateurs/:congresId/transport', express.urlencoded({ extended: true }), async (req, res) => {
  const congresId = parseInt(req.params.congresId);
  if (!requireOrganisateurCloud(req, res, congresId)) return;
  try {
    await upsertProgrammeConfig(congresId, { transport_info: req.body.transport_info || '' });
    res.redirect(`/organisateurs/${congresId}`);
  } catch (e) {
    console.error('[POST /organisateurs/transport]', e.message);
    res.status(500).send(pageLayout('Erreur', `<div class="success"><div class="icon">❌</div><h1>Erreur</h1><p>${escapeHtml(e.message)}</p></div>`));
  }
});

app.listen(PORT, () => {
  console.log(`✅ Serveur cloud NEXUS EVENT APP démarré sur le port ${PORT} (appel, inscription, partenaires, paiement)`);
});
