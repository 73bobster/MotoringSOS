// app.js — MotoringSOS UI logic.

let session = null;
let householdId = null;
let currentIncident = null;
let currentParties = [];
let currentPhotos = [];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------- Incident type configuration ----------
// Each type's reminder is persistent guidance (never a checkbox), and
// its tile list drives the hub screen entirely — adding a type or
// changing its tiles never touches the database schema.

const INCIDENT_TYPES = {
  accident: {
    label: 'Accident',
    icon: 'ti-car-crash',
    reminder: "Don't admit fault, sign anything, or agree to pay",
    tiles: ['safety', 'exchange', 'witnesses', 'photos', 'scene', 'police_scene', 'insurer', 'police_report', 'own_account'],
  },
  breakdown: {
    label: 'Breakdown or tyre damage',
    icon: 'ti-engine',
    reminder: 'Stay in the vehicle with your seatbelt on if on a motorway hard shoulder. Call your breakdown cover once safe.',
    tiles: ['safety', 'photos', 'scene'],
  },
  police_stop: {
    label: 'Stopped by police',
    icon: 'ti-shield-half',
    reminder: 'You only have to give ID — you can produce documents at a station later',
    tiles: ['police_scene', 'own_account'],
  },
  theft: {
    label: 'Theft or break-in',
    icon: 'ti-lock-open',
    reminder: "Don't touch damaged areas more than you have to",
    tiles: ['safety', 'photos', 'police_scene', 'insurer'],
  },
  witness_crime: {
    label: 'Witnessing a crime',
    icon: 'ti-eye',
    reminder: "Don't intervene — observe from a safe distance",
    tiles: ['safety', 'photos', 'own_account'],
  },
};

const TILE_DEFS = {
  safety: { title: 'Safety check', icon: 'ti-first-aid-kit', wide: true, screen: 'safety' },
  exchange: { title: 'Exchange details', icon: 'ti-id', screen: 'exchange' },
  witnesses: { title: 'Witnesses', icon: 'ti-users', screen: 'witnesses' },
  photos: { title: 'Photos', icon: 'ti-camera', screen: 'photos' },
  scene: { title: 'Scene notes', icon: 'ti-cloud', screen: 'scene' },
  police_scene: { title: 'Police at scene', icon: 'ti-shield-half', screen: 'police_scene' },
  insurer: { title: 'Notify insurer', icon: 'ti-building-bank', screen: 'insurer' },
  police_report: { title: 'Report to police', icon: 'ti-file-text', screen: 'police_report' },
  own_account: { title: 'Your account', icon: 'ti-notebook', screen: 'own_account' },
};

function tileStatus(tileId, incident, parties, photos) {
  switch (tileId) {
    case 'safety':
      if (incident.safety_confirmed === true) return { cls: 'green', text: 'Done' };
      if (incident.safety_confirmed === false) return incident.injury_description ? { cls: 'green', text: 'Logged' } : { cls: 'red', text: 'Incomplete' };
      return { cls: 'red', text: 'Not started' };
    case 'exchange': {
      const n = parties.filter((p) => p.party_type === 'other_driver').length;
      if (n > 0) return { cls: 'green', text: 'Done' };
      if (incident.checklist_state && incident.checklist_state.exchange_no_other_party) return { cls: 'green', text: 'N/A' };
      return { cls: 'red', text: 'Not started' };
    }
    case 'witnesses': {
      const n = parties.filter((p) => p.party_type === 'independent_witness' || p.party_type === 'other_party_witness').length;
      if (incident.witnesses_marked_done) return { cls: 'green', text: n ? `Done · ${n}` : 'Done' };
      return n > 0 ? { cls: 'amber', text: `${n} added` } : { cls: 'red', text: 'Not started' };
    }
    case 'photos': {
      const n = photos.length;
      if (incident.photos_marked_done) return { cls: 'green', text: n ? `Done · ${n}` : 'Done' };
      return n > 0 ? { cls: 'amber', text: `${n} added` } : { cls: 'red', text: 'Not started' };
    }
    case 'scene':
      return (incident.location_text || incident.weather_conditions || incident.road_conditions)
        ? { cls: 'green', text: 'Done' } : { cls: 'red', text: 'Not started' };
    case 'police_scene':
      if (incident.police_attended === true) return { cls: 'green', text: 'Logged' };
      if (incident.police_attended === false) return { cls: 'green', text: 'N/A' };
      return { cls: 'red', text: 'Not started' };
    case 'insurer':
      return incident.insurer_notified ? { cls: 'green', text: 'Notified' } : { cls: 'red', text: 'Due in 24h' };
    case 'police_report':
      if (incident.police_report_filed) return { cls: 'green', text: 'Filed' };
      if (incident.police_report_required === false) return { cls: 'green', text: 'N/A' };
      if (incident.police_report_required === true) return { cls: 'amber', text: 'Due in 24h' };
      return { cls: 'red', text: 'Not started' };
    case 'own_account':
      return incident.own_account ? { cls: 'green', text: 'Done' } : { cls: 'red', text: 'Not started' };
    default:
      return { cls: 'red', text: 'Not started' };
  }
}

// ---------- Screen navigation ----------

function showScreen(id) {
  $$('.screen').forEach((s) => s.classList.add('hidden'));
  const el = document.getElementById('screen-' + id);
  if (el) el.classList.remove('hidden');
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  $('.app-shell').appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

function timeAgo(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return new Date(iso).toLocaleDateString();
}

// ---------- Entry / auth ----------

let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('#tab-login').classList.toggle('active', mode === 'login');
  $('#tab-register').classList.toggle('active', mode === 'register');
  $('#auth-submit').textContent = mode === 'login' ? 'Log in' : 'Create account';
}

async function handleAuthSubmit() {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const errorEl = $('#auth-error');
  errorEl.textContent = '';
  if (!email || !password) { errorEl.textContent = 'Enter an email and password'; return; }
  try {
    if (authMode === 'login') await Sync.signIn(email, password);
    else await Sync.signUp(email, password);
    await boot();
  } catch (err) {
    errorEl.textContent = err.message || 'Something went wrong.';
  }
}

async function handleContinueWithoutSignIn() {
  try {
    await Sync.signInAnonymously();
    await boot();
  } catch (err) {
    $('#auth-error').textContent = err.message || "Couldn't continue without signing in.";
  }
}

async function handleForgotPassword() {
  const email = $('#auth-email').value.trim();
  const errorEl = $('#auth-error');
  const infoEl = $('#auth-info');
  errorEl.textContent = '';
  infoEl.textContent = '';
  if (!email) {
    errorEl.textContent = 'Enter your email above first, then tap "Forgot password?"';
    return;
  }
  try {
    await Sync.resetPasswordForEmail(email);
    infoEl.textContent = 'Check your email for a password reset link.';
  } catch (err) {
    errorEl.textContent = err.message || "Couldn't send the reset email.";
  }
}

async function handleSetNewPassword() {
  const pw = $('#new-password').value;
  const errorEl = $('#reset-error');
  errorEl.textContent = '';
  if (!pw || pw.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters';
    return;
  }
  try {
    await Sync.updatePassword(pw);
    toast('Password updated');
    await boot();
  } catch (err) {
    errorEl.textContent = err.message || "Couldn't update your password.";
  }
}

// ---------- Home screen ----------

async function boot() {
  session = await Sync.getSession();
  if (!session) { showScreen('entry'); return; }
  householdId = await Sync.getMyHouseholdId();
  await renderHome();
  showScreen('home');
}

async function renderHome() {
  const openIncidents = await Sync.fetchMyOpenIncidents();
  const closedIncidents = await Sync.fetchMyClosedIncidents();

  const banner = $('#unfinished-banner');
  if (openIncidents.length) {
    const inc = openIncidents[0];
    const cfg = INCIDENT_TYPES[inc.incident_type];
    const parties = await Sync.fetchParties(inc.id);
    const photos = await Sync.fetchPhotos(inc.id);
    const doneCount = cfg.tiles.filter((t) => tileStatus(t, inc, parties, photos).cls === 'green').length;
    banner.classList.remove('hidden');
    banner.querySelector('.title').textContent = `Unfinished incident · ${doneCount} of ${cfg.tiles.length} done`;
    banner.querySelector('.sub').textContent = `${cfg.label} · started ${timeAgo(inc.started_at)}`;
    banner.onclick = () => openIncidentHub(inc.id);
  } else {
    banner.classList.add('hidden');
  }

  const list = $('#history-list');
  list.innerHTML = closedIncidents.length
    ? closedIncidents.map((inc) => {
        const cfg = INCIDENT_TYPES[inc.incident_type];
        return `<div class="history-card" data-open="${inc.id}">
          <p class="title">${cfg.label}</p>
          <p class="sub">${new Date(inc.started_at).toLocaleDateString()} · ${inc.title ? escapeHtml(inc.title) : 'No summary'}</p>
        </div>`;
      }).join('')
    : '<p class="empty">No past incidents.</p>';
  list.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openIncidentHub(el.dataset.open));
  });

  $('#account-note').textContent = Sync.isAnonymous(session)
    ? 'Not signed in — your incidents are saved on this device only'
    : (session.user.email || 'Signed in');
}

// ---------- Type picker ----------

function openTypePicker() {
  const list = $('#type-list');
  list.innerHTML = Object.entries(INCIDENT_TYPES).map(([key, cfg]) => `
    <div class="type-option" data-type="${key}">
      <i class="ti ${cfg.icon}" aria-hidden="true"></i>
      <span>${cfg.label}</span>
    </div>`).join('');
  list.querySelectorAll('[data-type]').forEach((el) => {
    el.addEventListener('click', () => handleTypeChosen(el.dataset.type));
  });
  showScreen('type-picker');
}

async function handleTypeChosen(type) {
  try {
    const incident = await Sync.createIncident(type);
    await openIncidentHub(incident.id);
  } catch (err) {
    toast(err.message || "Couldn't start the incident");
  }
}

// ---------- Incident hub ----------

async function openIncidentHub(incidentId) {
  currentIncident = await Sync.fetchIncident(incidentId);
  currentParties = await Sync.fetchParties(incidentId);
  currentPhotos = await Sync.fetchPhotos(incidentId);
  renderHub();
  showScreen('hub');
}

async function refreshHub() {
  currentIncident = await Sync.fetchIncident(currentIncident.id);
  currentParties = await Sync.fetchParties(currentIncident.id);
  currentPhotos = await Sync.fetchPhotos(currentIncident.id);
  renderHub();
}

function renderHub() {
  const cfg = INCIDENT_TYPES[currentIncident.incident_type];
  $('#hub-title').textContent = cfg.label;
  $('#hub-timestamp').textContent = `Started ${new Date(currentIncident.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${timeAgo(currentIncident.started_at)}`;

  const reminderEl = $('#hub-reminder');
  if (cfg.reminder) { reminderEl.classList.remove('hidden'); reminderEl.querySelector('span').textContent = cfg.reminder; }
  else reminderEl.classList.add('hidden');

  const statuses = cfg.tiles.map((t) => tileStatus(t, currentIncident, currentParties, currentPhotos));
  const greenCount = statuses.filter((s) => s.cls === 'green').length;
  const amberCount = statuses.filter((s) => s.cls === 'amber').length;
  $('#hub-progress-text').textContent = `${greenCount} of ${cfg.tiles.length} done`;
  const track = $('#hub-progress-track');
  track.innerHTML = `<div style="width:${(greenCount / cfg.tiles.length) * 100}%;background:var(--ok)"></div>
    <div style="width:${(amberCount / cfg.tiles.length) * 100}%;background:#EF9F27"></div>`;

  const wideTiles = cfg.tiles.filter((t) => TILE_DEFS[t].wide);
  const gridTiles = cfg.tiles.filter((t) => !TILE_DEFS[t].wide);

  $('#hub-wide-tiles').innerHTML = wideTiles.map((t) => renderTile(t, true)).join('');
  $('#hub-tile-grid').innerHTML = gridTiles.map((t) => renderTile(t, false)).join('');
  $$('.tile').forEach((el) => {
    el.addEventListener('click', () => openSubScreen(el.dataset.tile));
  });
}

function renderTile(tileId, wide) {
  const def = TILE_DEFS[tileId];
  const status = tileStatus(tileId, currentIncident, currentParties, currentPhotos);
  return `<div class="tile ${wide ? 'wide' : ''} status-${status.cls}" data-tile="${tileId}">
    <i class="ti ${def.icon} tile-icon" aria-hidden="true"></i>
    <div style="flex:1">
      <p class="tile-title">${def.title}</p>
      <span class="tile-status">${status.text}</span>
    </div>
  </div>`;
}

function openSubScreen(tileId) {
  const screen = TILE_DEFS[tileId].screen;
  const renderers = {
    safety: renderSafetyScreen,
    exchange: renderExchangeScreen,
    witnesses: renderWitnessesScreen,
    photos: renderPhotosScreen,
    scene: renderSceneScreen,
    police_scene: renderPoliceSceneScreen,
    insurer: renderInsurerScreen,
    police_report: renderPoliceReportScreen,
    own_account: renderOwnAccountScreen,
  };
  renderers[screen]();
  showScreen('sub-' + screen);
}

// ---------- Safety sub-screen ----------

function renderSafetyScreen() {
  const inc = currentIncident;
  $('#safety-yes').classList.toggle('selected-yes', inc.safety_confirmed === true);
  $('#safety-no').classList.toggle('selected-no', inc.safety_confirmed === false);
  $('#safety-yes').style.background = inc.safety_confirmed === true ? 'var(--ink)' : '';
  $('#safety-yes').style.color = inc.safety_confirmed === true ? 'var(--paper)' : '';
  $('#injury-panel').classList.toggle('hidden', inc.safety_confirmed !== false);
  $('#injury-description').value = inc.injury_description || '';
  $('#ambulance-yes').style.background = inc.ambulance_called === true ? 'var(--rust)' : '';
  $('#ambulance-yes').style.color = inc.ambulance_called === true ? '#fff' : '';
  $('#ambulance-no').style.background = inc.ambulance_called === false ? 'var(--ink)' : '';
  $('#ambulance-no').style.color = inc.ambulance_called === false ? 'var(--paper)' : '';
}

async function setSafety(confirmed) {
  currentIncident.safety_confirmed = confirmed;
  currentIncident.injury_reported = confirmed === false;
  if (confirmed === true) { currentIncident.injury_description = null; currentIncident.ambulance_called = null; }
  renderSafetyScreen();
}
async function setAmbulance(called) { currentIncident.ambulance_called = called; renderSafetyScreen(); }

async function saveSafety() {
  try {
    await Sync.updateIncident(currentIncident.id, {
      safety_confirmed: currentIncident.safety_confirmed,
      injury_reported: currentIncident.injury_reported,
      injury_description: $('#injury-description').value || null,
      ambulance_called: currentIncident.ambulance_called,
    });
    await refreshHub();
    showScreen('hub');
  } catch (err) { toast(err.message); }
}

// ---------- Exchange details sub-screen (other driver) ----------

function renderExchangeScreen() {
  const others = currentParties.filter((p) => p.party_type === 'other_driver');
  const noOtherParty = !!(currentIncident.checklist_state && currentIncident.checklist_state.exchange_no_other_party);

  $('#exchange-done-banner').classList.toggle('hidden', !noOtherParty);
  $('#exchange-no-other-btn').classList.toggle('hidden', noOtherParty || others.length > 0);

  const list = $('#exchange-list');
  list.innerHTML = others.length
    ? others.map((p) => `<div class="party-card">
        <div class="top"><span class="name">${escapeHtml(p.name || 'Unnamed driver')}</span><span class="remove" data-remove="${p.id}">Remove</span></div>
        <p class="detail">${[p.vehicle_registration, p.insurer, p.phone].filter(Boolean).join(' · ') || 'No details given'}</p>
      </div>`).join('')
    : (noOtherParty ? '' : '<p class="empty">No other driver added yet — a single-vehicle incident? Mark "No other party involved" below.</p>');
  list.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => removeParty(el.dataset.remove, renderExchangeScreen)));
  $('#exchange-form').classList.add('hidden');
}

// Marking "no other party" is a statement about the incident, not just an
// empty list — so it's stored and shown distinctly from "not started yet",
// the same distinction witnesses/photos draw with their own marked-done flag.
async function markExchangeNoOtherParty() {
  const nextState = { ...(currentIncident.checklist_state || {}), exchange_no_other_party: true };
  await Sync.updateIncident(currentIncident.id, { checklist_state: nextState });
  currentIncident.checklist_state = nextState;
  renderExchangeScreen();
}
async function undoExchangeNoOtherParty() {
  const nextState = { ...(currentIncident.checklist_state || {}), exchange_no_other_party: false };
  await Sync.updateIncident(currentIncident.id, { checklist_state: nextState });
  currentIncident.checklist_state = nextState;
  renderExchangeScreen();
}

function showExchangeForm() {
  $('#exchange-form').classList.remove('hidden');
  ['ex-name', 'ex-phone', 'ex-reg', 'ex-insurer'].forEach((id) => { $('#' + id).value = ''; });
}

async function saveExchangeParty() {
  try {
    await Sync.addParty(currentIncident.id, {
      party_type: 'other_driver',
      name: $('#ex-name').value || null,
      phone: $('#ex-phone').value || null,
      vehicle_registration: $('#ex-reg').value || null,
      insurer: $('#ex-insurer').value || null,
    });
    // Adding a driver contradicts "no other party involved" — clear it silently.
    if (currentIncident.checklist_state && currentIncident.checklist_state.exchange_no_other_party) {
      await undoExchangeNoOtherParty();
    }
    currentParties = await Sync.fetchParties(currentIncident.id);
    renderExchangeScreen();
  } catch (err) { toast(err.message); }
}

// ---------- Witnesses sub-screen ----------

function renderWitnessesScreen() {
  const witnesses = currentParties.filter((p) => p.party_type === 'independent_witness' || p.party_type === 'other_party_witness');
  const banner = $('#witnesses-done-banner');
  banner.classList.toggle('hidden', !currentIncident.witnesses_marked_done);

  const list = $('#witnesses-list');
  list.innerHTML = witnesses.length
    ? witnesses.map((p) => `<div class="party-card">
        <div class="top"><span class="name">${escapeHtml(p.name || 'Unnamed witness')}</span><span class="remove" data-remove="${p.id}">Remove</span></div>
        <p class="detail">${p.declined_details ? 'No contact details given' : (p.phone || 'No phone given')}</p>
      </div>`).join('')
    : '<p class="empty">No witnesses added yet.</p>';
  list.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => removeParty(el.dataset.remove, renderWitnessesScreen)));
  $('#witnesses-form').classList.add('hidden');
  $('#witnesses-mark-done').classList.toggle('hidden', currentIncident.witnesses_marked_done);
}

function showWitnessForm() {
  $('#witnesses-form').classList.remove('hidden');
  ['wit-name', 'wit-phone'].forEach((id) => { $('#' + id).value = ''; });
  $('#wit-declined').checked = false;
}

async function saveWitness() {
  try {
    await Sync.addParty(currentIncident.id, {
      party_type: 'independent_witness',
      name: $('#wit-name').value || null,
      phone: $('#wit-phone').value || null,
      declined_details: $('#wit-declined').checked,
    });
    currentParties = await Sync.fetchParties(currentIncident.id);
    renderWitnessesScreen();
  } catch (err) { toast(err.message); }
}

async function markWitnessesDone() {
  await Sync.updateIncident(currentIncident.id, { witnesses_marked_done: true });
  currentIncident.witnesses_marked_done = true;
  renderWitnessesScreen();
}
async function undoWitnessesDone() {
  await Sync.updateIncident(currentIncident.id, { witnesses_marked_done: false });
  currentIncident.witnesses_marked_done = false;
  renderWitnessesScreen();
}

async function removeParty(id, rerender) {
  try { await Sync.deleteParty(id); currentParties = await Sync.fetchParties(currentIncident.id); rerender(); }
  catch (err) { toast(err.message); }
}

// ---------- Photos sub-screen ----------

function renderPhotosScreen() {
  const banner = $('#photos-done-banner');
  banner.classList.toggle('hidden', !currentIncident.photos_marked_done);
  const statusLine = $('#photos-status-line');
  statusLine.textContent = currentPhotos.length ? `${currentPhotos.length} added — mark done once you have enough` : 'No photos yet';
  statusLine.classList.toggle('hidden', currentIncident.photos_marked_done);

  const list = $('#photos-list');
  list.innerHTML = currentPhotos.map((p) => {
    let metaLine;
    if (p.taken_at) {
      metaLine = `<p class="loc"><i class="ti ti-map-pin" aria-hidden="true"></i> ${new Date(p.taken_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${p.location_lat ? ' · location recorded' : ''}</p>`;
    } else {
      metaLine = `<p class="warn"><i class="ti ti-alert-circle" aria-hidden="true"></i> No time or location in photo</p>`;
    }
    return `<div class="photo-row">
      <div class="photo-thumb"><i class="ti ti-photo" style="color:#B4B2A9" aria-hidden="true"></i></div>
      <div class="meta"><p class="title">${p.source === 'captured_in_app' ? 'Taken in app' : 'From gallery'}</p>${metaLine}</div>
      <span class="remove" data-remove="${p.id}" data-path="${p.storage_path}">Remove</span>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-remove]').forEach((el) => {
    el.addEventListener('click', async () => {
      try { await Sync.deletePhoto(el.dataset.remove, el.dataset.path); currentPhotos = await Sync.fetchPhotos(currentIncident.id); renderPhotosScreen(); }
      catch (err) { toast(err.message); }
    });
  });
  $('#photos-mark-done').classList.toggle('hidden', currentIncident.photos_marked_done);
}

async function handleTakePhoto(fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  let lat = null, lng = null;
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 }));
    lat = pos.coords.latitude; lng = pos.coords.longitude;
  } catch { /* location unavailable — proceed without it */ }
  try {
    await Sync.addPhoto(currentIncident.id, file, {
      source: 'captured_in_app', taken_at: new Date().toISOString(),
      location_lat: lat, location_lng: lng, has_exif_data: false,
    });
    currentPhotos = await Sync.fetchPhotos(currentIncident.id);
    renderPhotosScreen();
  } catch (err) { toast(err.message); }
  fileInput.value = '';
}

async function handleImportPhotos(fileInput) {
  const files = Array.from(fileInput.files || []);
  for (const file of files) {
    let exif = null;
    try { exif = await parseExif(file); } catch { /* unreadable EXIF — treat as absent */ }
    try {
      await Sync.addPhoto(currentIncident.id, file, {
        source: 'imported_gallery',
        taken_at: exif && exif.takenAt ? exif.takenAt : null,
        location_lat: exif && exif.lat != null ? exif.lat : null,
        location_lng: exif && exif.lng != null ? exif.lng : null,
        has_exif_data: !!(exif && exif.takenAt),
      });
    } catch (err) { toast(err.message); }
  }
  currentPhotos = await Sync.fetchPhotos(currentIncident.id);
  renderPhotosScreen();
  fileInput.value = '';
}

async function markPhotosDone() {
  await Sync.updateIncident(currentIncident.id, { photos_marked_done: true });
  currentIncident.photos_marked_done = true;
  renderPhotosScreen();
}
async function undoPhotosDone() {
  await Sync.updateIncident(currentIncident.id, { photos_marked_done: false });
  currentIncident.photos_marked_done = false;
  renderPhotosScreen();
}

// Minimal best-effort JPEG EXIF reader: DateTimeOriginal + GPS coordinates
// only. Many photos (especially ones forwarded via messaging apps) have no
// EXIF at all — that's treated as a normal, expected outcome, not an error.
async function parseExif(file) {
  const buf = await file.slice(0, 131072).arrayBuffer(); // first 128KB is enough for EXIF
  const view = new DataView(buf);
  if (view.getUint16(0) !== 0xFFD8) return null; // not a JPEG
  let offset = 2;
  while (offset < view.byteLength) {
    if (view.getUint8(offset) !== 0xFF) break;
    const marker = view.getUint8(offset + 1);
    const size = view.getUint16(offset + 2);
    if (marker === 0xE1) { // APP1 — likely EXIF
      const tiffStart = offset + 10; // skip "Exif\0\0"
      if (view.getUint32(offset + 4, false) !== 0x45786966) { offset += 2 + size; continue; }
      const little = view.getUint16(tiffStart) === 0x4949;
      const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, little);
      const tags = readIfd(view, tiffStart, ifd0Offset, little);
      let result = { takenAt: null, lat: null, lng: null };
      if (tags[0x8769]) { // Exif sub-IFD
        const exifTags = readIfd(view, tiffStart, tiffStart + tags[0x8769].value, little);
        if (exifTags[0x9003]) result.takenAt = parseExifDate(readAscii(view, tiffStart + exifTags[0x9003].valueOffset, exifTags[0x9003].count));
      }
      if (tags[0x8825]) { // GPS sub-IFD
        const gpsTags = readIfd(view, tiffStart, tiffStart + tags[0x8825].value, little);
        const lat = readGpsCoord(view, tiffStart, gpsTags[2], little);
        const lng = readGpsCoord(view, tiffStart, gpsTags[4], little);
        if (lat != null) result.lat = gpsTags[1] && readAscii(view, gpsTags[1].valueOffset, 2) === 'S' ? -lat : lat;
        if (lng != null) result.lng = gpsTags[3] && readAscii(view, gpsTags[3].valueOffset, 2) === 'W' ? -lng : lng;
      }
      return result;
    }
    offset += 2 + size;
  }
  return null;
}
function readIfd(view, tiffStart, ifdOffset, little) {
  const count = view.getUint16(ifdOffset, little);
  const tags = {};
  for (let i = 0; i < count; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const tag = view.getUint16(entryOffset, little);
    const type = view.getUint16(entryOffset + 2, little);
    const numValues = view.getUint32(entryOffset + 4, little);
    const valueOffsetField = entryOffset + 8;
    const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8 }[type] || 1;
    const totalSize = typeSize * numValues;
    const valueOffset = totalSize > 4 ? tiffStart + view.getUint32(valueOffsetField, little) : valueOffsetField;
    tags[tag] = { value: totalSize <= 4 ? view.getUint32(valueOffsetField, little) : null, valueOffset, count: numValues, type };
  }
  return tags;
}
function readAscii(view, offset, count) {
  let str = '';
  for (let i = 0; i < count - 1; i++) str += String.fromCharCode(view.getUint8(offset + i));
  return str;
}
function parseExifDate(str) {
  // Format: "YYYY:MM:DD HH:MM:SS"
  const m = str.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString();
}
function readGpsCoord(view, tiffStart, tag, little) {
  if (!tag) return null;
  const base = tag.valueOffset;
  const deg = view.getUint32(base, little) / view.getUint32(base + 4, little);
  const min = view.getUint32(base + 8, little) / view.getUint32(base + 12, little);
  const sec = view.getUint32(base + 16, little) / view.getUint32(base + 20, little);
  return deg + min / 60 + sec / 3600;
}

// ---------- Scene notes sub-screen ----------

function renderSceneScreen() {
  $('#scene-location').value = currentIncident.location_text || '';
  $('#scene-weather').value = currentIncident.weather_conditions || '';
  $('#scene-road').value = currentIncident.road_conditions || '';
}
async function useCurrentLocation() {
  try {
    const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 }));
    $('#scene-location').value = `${pos.coords.latitude.toFixed(5)}, ${pos.coords.longitude.toFixed(5)}`;
    currentIncident.location_lat = pos.coords.latitude;
    currentIncident.location_lng = pos.coords.longitude;
  } catch { toast("Couldn't get your location"); }
}
async function saveScene() {
  try {
    await Sync.updateIncident(currentIncident.id, {
      location_text: $('#scene-location').value || null,
      weather_conditions: $('#scene-weather').value || null,
      road_conditions: $('#scene-road').value || null,
      location_lat: currentIncident.location_lat || null,
      location_lng: currentIncident.location_lng || null,
    });
    await refreshHub();
    showScreen('hub');
  } catch (err) { toast(err.message); }
}

// ---------- Police at scene sub-screen ----------

function renderPoliceSceneScreen() {
  const inc = currentIncident;
  $('#police-yes').style.background = inc.police_attended === true ? 'var(--ink)' : '';
  $('#police-yes').style.color = inc.police_attended === true ? 'var(--paper)' : '';
  $('#police-no').style.background = inc.police_attended === false ? 'var(--ink)' : '';
  $('#police-no').style.color = inc.police_attended === false ? 'var(--paper)' : '';
  $('#police-fields').classList.toggle('hidden', inc.police_attended !== true);
  $('#police-officer-name').value = inc.police_officer_name || '';
  $('#police-collar').value = inc.police_collar_number || '';
  $('#police-reference').value = inc.police_incident_reference || '';
}
function setPoliceAttended(attended) { currentIncident.police_attended = attended; renderPoliceSceneScreen(); }
async function savePoliceScene() {
  try {
    await Sync.updateIncident(currentIncident.id, {
      police_attended: currentIncident.police_attended,
      police_officer_name: $('#police-officer-name').value || null,
      police_collar_number: $('#police-collar').value || null,
      police_incident_reference: $('#police-reference').value || null,
    });
    await refreshHub();
    showScreen('hub');
  } catch (err) { toast(err.message); }
}

// ---------- Afterwards: insurer ----------

function renderInsurerScreen() {
  const notified = currentIncident.insurer_notified;
  $('#insurer-status').textContent = notified ? `Notified ${timeAgo(currentIncident.insurer_notified_at)}` : 'Not yet notified';
  $('#insurer-mark-btn').classList.toggle('hidden', notified);
}
async function markInsurerNotified() {
  try {
    await Sync.updateIncident(currentIncident.id, { insurer_notified: true, insurer_notified_at: new Date().toISOString() });
    await refreshHub();
    showScreen('hub');
  } catch (err) { toast(err.message); }
}

// ---------- Afterwards: police report ----------

function renderPoliceReportScreen() {
  const inc = currentIncident;
  $('#report-yes').style.background = inc.police_report_required === true ? 'var(--ink)' : '';
  $('#report-yes').style.color = inc.police_report_required === true ? 'var(--paper)' : '';
  $('#report-no').style.background = inc.police_report_required === false ? 'var(--ink)' : '';
  $('#report-no').style.color = inc.police_report_required === false ? 'var(--paper)' : '';
  $('#report-fields').classList.toggle('hidden', inc.police_report_required !== true);
  $('#report-reference').value = inc.police_report_reference || '';
  $('#report-filed-check').checked = !!inc.police_report_filed;
}
function setReportRequired(required) { currentIncident.police_report_required = required; renderPoliceReportScreen(); }
async function savePoliceReport() {
  try {
    await Sync.updateIncident(currentIncident.id, {
      police_report_required: currentIncident.police_report_required,
      police_report_filed: $('#report-filed-check').checked,
      police_report_reference: $('#report-reference').value || null,
    });
    await refreshHub();
    showScreen('hub');
  } catch (err) { toast(err.message); }
}

// ---------- Own account ----------

function renderOwnAccountScreen() {
  $('#own-account-text').value = currentIncident.own_account || '';
}
async function saveOwnAccount() {
  try {
    await Sync.updateIncident(currentIncident.id, { own_account: $('#own-account-text').value || null });
    await refreshHub();
    showScreen('hub');
  } catch (err) { toast(err.message); }
}

// ---------- Export / save screen ----------

async function openExportScreen() {
  $('#export-account-row').classList.toggle('done', !Sync.isAnonymous(session));
  $('#export-account-sub').textContent = Sync.isAnonymous(session)
    ? 'Log in to save this permanently'
    : 'Saved automatically · syncs across devices';
  showScreen('export');
}

async function downloadIncidentCopy() {
  // Simplification, flagged to the user: this downloads the photos
  // individually plus one text summary, rather than a single zip —
  // building a real zip client-side would need a library, which runs
  // against this project's no-build-tooling approach.
  const cfg = INCIDENT_TYPES[currentIncident.incident_type];
  const lines = [
    `MotoringSOS incident — ${cfg.label}`,
    `Started: ${new Date(currentIncident.started_at).toLocaleString()}`,
    currentIncident.title ? `Summary: ${currentIncident.title}` : '',
    '',
    'Other parties:',
    ...currentParties.map((p) => `- [${p.party_type}] ${p.name || 'unnamed'} ${p.phone || ''} ${p.vehicle_registration || ''} ${p.insurer || ''}`.trim()),
    '',
    `Scene: ${currentIncident.location_text || '—'} · ${currentIncident.weather_conditions || '—'} · ${currentIncident.road_conditions || '—'}`,
    `Police attended: ${currentIncident.police_attended === true ? 'Yes' : currentIncident.police_attended === false ? 'No' : '—'}`,
    currentIncident.own_account ? `\nAccount:\n${currentIncident.own_account}` : '',
  ].filter(Boolean).join('\n');

  const blob = new Blob([lines], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `motoringsos-incident-${currentIncident.id.slice(0, 8)}.txt`;
  a.click();
  URL.revokeObjectURL(url);

  for (const photo of currentPhotos) {
    try {
      const signedUrl = await Sync.getPhotoUrl(photo.storage_path);
      const resp = await fetch(signedUrl);
      const blob2 = await resp.blob();
      const url2 = URL.createObjectURL(blob2);
      const a2 = document.createElement('a');
      a2.href = url2; a2.download = `motoringsos-${currentIncident.id.slice(0, 8)}-photo.jpg`;
      a2.click();
      URL.revokeObjectURL(url2);
    } catch { /* one photo failing shouldn't stop the rest */ }
  }
  toast('Downloaded summary and photos');
}

async function shareIncident() {
  if (!navigator.share) { toast('Sharing is not supported on this browser — use Download instead'); return; }
  try {
    await navigator.share({
      title: 'MotoringSOS incident',
      text: `${INCIDENT_TYPES[currentIncident.incident_type].label} — started ${new Date(currentIncident.started_at).toLocaleString()}`,
    });
  } catch { /* user cancelled share — not an error */ }
}

async function closeIncidentAndGoHome() {
  try {
    await Sync.closeIncident(currentIncident.id);
    await renderHome();
    showScreen('home');
  } catch (err) { toast(err.message); }
}

// ---------- Wire up ----------

window.addEventListener('DOMContentLoaded', async () => {
  $('#tab-login').addEventListener('click', () => setAuthMode('login'));
  $('#tab-register').addEventListener('click', () => setAuthMode('register'));
  $('#auth-submit').addEventListener('click', handleAuthSubmit);
  $('#continue-anon-btn').addEventListener('click', handleContinueWithoutSignIn);
  $('#forgot-password-btn').addEventListener('click', handleForgotPassword);
  $('#set-new-password-btn').addEventListener('click', handleSetNewPassword);

  // Fires when the user arrives back in the app via a password-reset
  // email link, rather than through a normal sign-in.
  Sync.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') showScreen('set-new-password');
  });

  $('#sos-button').addEventListener('click', openTypePicker);
  $('#type-back').addEventListener('click', () => showScreen('home'));
  $('#logout-btn').addEventListener('click', async () => { await Sync.signOut(); showScreen('entry'); });

  $('#hub-back').addEventListener('click', () => showScreen('home'));
  $('#hub-export-btn').addEventListener('click', openExportScreen);

  $('#safety-back').addEventListener('click', () => showScreen('hub'));
  $('#safety-yes').addEventListener('click', () => setSafety(true));
  $('#safety-no').addEventListener('click', () => setSafety(false));
  $('#ambulance-yes').addEventListener('click', () => setAmbulance(true));
  $('#ambulance-no').addEventListener('click', () => setAmbulance(false));
  $('#safety-save').addEventListener('click', saveSafety);

  $('#exchange-back').addEventListener('click', () => showScreen('hub'));
  $('#exchange-add-btn').addEventListener('click', showExchangeForm);
  $('#exchange-save-btn').addEventListener('click', saveExchangeParty);
  $('#exchange-no-other-btn').addEventListener('click', markExchangeNoOtherParty);
  $('#exchange-undo').addEventListener('click', undoExchangeNoOtherParty);

  $('#witnesses-back').addEventListener('click', () => showScreen('hub'));
  $('#witnesses-add-btn').addEventListener('click', showWitnessForm);
  $('#witnesses-save-btn').addEventListener('click', saveWitness);
  $('#witnesses-mark-done').addEventListener('click', markWitnessesDone);
  $('#witnesses-undo').addEventListener('click', undoWitnessesDone);

  $('#photos-back').addEventListener('click', () => showScreen('hub'));
  $('#take-photo-input').addEventListener('change', (e) => handleTakePhoto(e.target));
  $('#import-photo-input').addEventListener('change', (e) => handleImportPhotos(e.target));
  $('#take-photo-btn').addEventListener('click', () => $('#take-photo-input').click());
  $('#import-photo-btn').addEventListener('click', () => $('#import-photo-input').click());
  $('#photos-mark-done').addEventListener('click', markPhotosDone);
  $('#photos-undo').addEventListener('click', undoPhotosDone);

  $('#scene-back').addEventListener('click', () => showScreen('hub'));
  $('#scene-use-location').addEventListener('click', useCurrentLocation);
  $('#scene-save').addEventListener('click', saveScene);

  $('#police-scene-back').addEventListener('click', () => showScreen('hub'));
  $('#police-yes').addEventListener('click', () => setPoliceAttended(true));
  $('#police-no').addEventListener('click', () => setPoliceAttended(false));
  $('#police-scene-save').addEventListener('click', savePoliceScene);

  $('#insurer-back').addEventListener('click', () => showScreen('hub'));
  $('#insurer-mark-btn').addEventListener('click', markInsurerNotified);

  $('#police-report-back').addEventListener('click', () => showScreen('hub'));
  $('#report-yes').addEventListener('click', () => setReportRequired(true));
  $('#report-no').addEventListener('click', () => setReportRequired(false));
  $('#police-report-save').addEventListener('click', savePoliceReport);

  $('#own-account-back').addEventListener('click', () => showScreen('hub'));
  $('#own-account-save').addEventListener('click', saveOwnAccount);

  $('#export-back').addEventListener('click', () => showScreen('hub'));
  $('#export-download-btn').addEventListener('click', downloadIncidentCopy);
  $('#export-share-btn').addEventListener('click', shareIncident);
  $('#export-close-btn').addEventListener('click', closeIncidentAndGoHome);

  window.addEventListener('online', async () => {
    $('#offline-banner').classList.add('hidden');
    const { flushed } = await Sync.flushQueue();
    if (flushed) toast(`Synced ${flushed} saved offline`);
  });
  window.addEventListener('offline', () => $('#offline-banner').classList.remove('hidden'));
  if (!navigator.onLine) $('#offline-banner').classList.remove('hidden');

  try { await boot(); } catch (err) { showScreen('entry'); $('#auth-error').textContent = err.message || 'Could not connect.'; }
});
