# Serveur cloud permanent — NEXUS EVENT APP

Ce dossier contient un **serveur séparé de l'application desktop NEXUS EVENT APP**,
fait pour tourner 24/7 chez un hébergeur (Render, Railway...), sans dépendre du
PC de l'organisateur. Il sert les formulaires publics de :
- **Appel à communication** (`/appel/:congresId`)
- **Inscription publique des participants** (`/inscription/:congresId`)
- **Espace partenaires** sponsors/exposants (`/partenaires/:congresId`)
- **Paiement en ligne** (`/paiement/:factureId`) — en mode test tant qu'aucun compte
  marchand SATIM/CIB n'est configuré

Toute la configuration continue de se piloter depuis ton application desktop habituelle.

## Comment ça s'articule avec l'appli desktop

```
[Ton appli desktop]  --publie la config-->  [Supabase]  <--sert les formulaires--  [Ce serveur cloud]
        ↑                                                                                  |
        └────────────── récupère les dépôts reçus (boutons "Synchroniser") ────────────────┘
```

1. Dans chaque module concerné de l'appli desktop (Appel à communication, Inscription
   publique, Espace partenaires, Facturation), tu publies la configuration ou génères
   un lien de paiement — ça écrit automatiquement dans Supabase.
2. Ce serveur cloud lit cette configuration dans Supabase et affiche les formulaires
   publics, 24/7, à une adresse fixe.
3. Quand quelqu'un dépose une communication, s'inscrit, postule comme partenaire, ou
   paie une facture, ce serveur l'écrit dans Supabase (pas dans ta base locale).
4. Dans l'appli desktop, tu cliques sur **"Synchroniser"** dans le module correspondant
   pour rapatrier les nouvelles données vers ta base locale.

## Étape 1 — Préparer Supabase

Dans ton projet Supabase, va dans **SQL Editor** et exécute ce script complet (une seule fois) :

```sql
-- ═══════════ Appel à communication ═══════════
create table if not exists appels_publics (
  congres_id integer primary key,
  congres_nom text not null,
  statut text default 'ouvert',
  criteres text,
  instructions_ppt text,
  instructions_poster text,
  date_limite text,
  contact_email text,
  updated_at timestamptz default now()
);

create table if not exists depots_publics (
  id bigint generated always as identity primary key,
  congres_id integer not null,
  titre text not null,
  auteur text not null,
  email text not null,
  type_presentation text default 'orale',
  fichier_ppt_url text,
  fichier_poster_url text,
  synced boolean default false,
  created_at timestamptz default now()
);

-- ═══════════ Inscription publique ═══════════
create table if not exists inscriptions_publiques_config (
  congres_id integer primary key,
  congres_nom text not null,
  statut text default 'ferme',
  date_limite text,
  message_bienvenue text,
  contact_email text,
  updated_at timestamptz default now()
);

create table if not exists tarifs_publics (
  id bigint generated always as identity primary key,
  congres_id integer not null,
  type_participant text,
  libelle text,
  montant numeric,
  devise text default 'DZD',
  date_limite text
);

create table if not exists inscriptions_recues (
  id bigint generated always as identity primary key,
  congres_id integer not null,
  prenom text not null,
  nom text not null,
  email text not null,
  telephone text,
  institution text,
  specialite text,
  type_participant text default 'participant',
  categorie text,
  regime_alimentaire text,
  synced boolean default false,
  created_at timestamptz default now()
);

-- ═══════════ Espace partenaires ═══════════
create table if not exists partenaires_config (
  congres_id integer primary key,
  congres_nom text not null,
  statut text default 'ferme',
  date_limite text,
  message_bienvenue text,
  contact_email text,
  updated_at timestamptz default now()
);

create table if not exists partenaires_recus (
  id bigint generated always as identity primary key,
  congres_id integer not null,
  type_partenaire text default 'sponsor',
  entreprise text not null,
  secteur text,
  produits text,
  contact_nom text not null,
  contact_email text not null,
  contact_tel text,
  logo_url text,
  synced boolean default false,
  created_at timestamptz default now()
);

-- ═══════════ Paiement en ligne ═══════════
create table if not exists paiements_config (
  facture_id integer primary key,
  congres_id integer,
  congres_nom text,
  numero_facture text,
  montant_restant numeric,
  devise text default 'DZD',
  participant_nom text,
  updated_at timestamptz default now()
);

create table if not exists paiements_recus (
  id bigint generated always as identity primary key,
  facture_id integer not null,
  montant numeric not null,
  statut text default 'en_attente',
  reference_transaction text,
  synced boolean default false,
  created_at timestamptz default now()
);
```

Ensuite, va dans **Storage** → crée un nouveau bucket nommé exactement `communications-appel`,
et coche **Public bucket** (les fichiers déposés — présentations, logos — doivent être
accessibles publiquement en lecture pour que l'appli desktop puisse les retélécharger).
Ce même bucket est réutilisé pour les fichiers de l'appel à communication et les logos
des partenaires (dans des sous-dossiers séparés, pas de conflit).

## Étape 2 — Déployer sur Render (gratuit pour commencer, ~7$/mois pour un service qui ne s'endort jamais)

1. Crée un compte sur [render.com](https://render.com)
2. Mets ce dossier (`serveur-cloud-appel/`) dans un dépôt Git (GitHub, GitLab...) —
   ou demande à Claude Code / un développeur de le faire pour toi si tu n'es pas
   à l'aise avec Git.
3. Sur Render : **New** → **Web Service** → connecte ton dépôt Git, sélectionne
   ce dossier comme racine du service (`serveur-cloud-appel`).
4. Render détecte automatiquement Node.js. Configure :
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
5. Dans l'onglet **Environment**, ajoute ces variables :
   | Nom | Valeur |
   |---|---|
   | `SUPABASE_URL` | L'URL de ton projet Supabase (ex: `https://xxxxx.supabase.co`) |
   | `SUPABASE_SERVICE_KEY` | La clé **service_role** de ton projet Supabase (⚠️ pas la clé `anon`) |
   | `SUPABASE_STORAGE_BUCKET` | `communications-appel` (ou le nom choisi à l'étape 1) |
6. Clique sur **Create Web Service**. Après quelques minutes, Render te donne une adresse
   du type `https://nutri-cloud.onrender.com`.

## Étape 3 — Renseigner l'URL dans l'appli desktop

Dans l'appli desktop, va dans **Paramètres → Synchronisation cloud**, et renseigne :
- **URL du serveur cloud** : l'adresse Render obtenue à l'étape précédente (sans `/` final)
- **URL et clé Supabase** : déjà configurées si tu utilises la sauvegarde cloud

Une fois ça fait, chaque module (Appel, Inscription, Partenaires, Facturation) affichera
automatiquement le lien permanent basé sur cette URL.

## Étape 4 — Configurer un nom de domaine personnalisé (optionnel)

Dans les paramètres du service Render, section **Custom Domains**, tu peux relier
un nom de domaine que tu possèdes (ex: `congres.tonsite.dz`) — Render te donne les
enregistrements DNS exacts à ajouter chez ton registrar.

## Limitations à connaître

- **Plan gratuit Render** : le service "s'endort" après 15 minutes d'inactivité et met
  quelques secondes à se réveiller au premier visiteur — acceptable pour un usage
  ponctuel, frustrant si tu veux une réactivité immédiate en permanence (auquel cas,
  passe au plan payant, ~7$/mois).
- Le paiement reste en **mode test** sur ce serveur aussi tant que tu n'as pas de vrai
  compte marchand SATIM/CIB — la simulation fonctionne pour tester le circuit complet,
  mais aucun vrai paiement n'est traité.
- Penser à cliquer sur **Synchroniser** régulièrement dans chaque module concerné de
  l'appli desktop — rien n'est perdu en attendant, mais les nouvelles données
  n'apparaissent localement qu'après synchronisation.

