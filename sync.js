// sync.js — data layer for MotoringSOS.
// Talks to the SAME Supabase project as MotoringMonitor and LeasedMileage:
// same auth, same households. Adds only the incidents / incident_party /
// incident_photos tables (and the incident-photos storage bucket), all of
// which were added additively — nothing here touches MM's or LM's tables.

const SUPABASE_URL = 'https://izqlirhiuzunwghwquog.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GYHc9BeohzdBKNkEsY_ckA_kg0gDYCU';

const QUEUE_KEY = 'motoringsos_offline_queue';

let _supabase = null;
function getClient() {
  if (_supabase) return _supabase;
  if (typeof window.supabase === 'undefined') {
    throw new Error('Supabase library failed to load — check your internet connection.');
  }
  _supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return _supabase;
}

const Sync = {

  // ---------- Auth ----------

  async signUp(email, password) {
    const { data, error } = await getClient().auth.signUp({ email, password });
    if (error) throw error;
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  // The core of "works without an account": a real, persistent Supabase
  // auth user with no email/password. The session caches in this browser's
  // local storage automatically, so re-opening the app later returns to
  // the same identity and the same incidents.
  async signInAnonymously() {
    const { data, error } = await getClient().auth.signInAnonymously();
    if (error) throw error;
    return data;
  },

  // Upgrades the current anonymous session to a real account, carrying
  // every incident recorded under it forward (same auth.uid() throughout).
  async linkToEmail(email, password) {
    const { data, error } = await getClient().auth.updateUser({ email, password });
    if (error) throw error;
    return data;
  },

  async signOut() {
    await getClient().auth.signOut();
  },

  async getSession() {
    const { data } = await getClient().auth.getSession();
    return data.session;
  },

  isAnonymous(session) {
    return !!(session && session.user && session.user.is_anonymous);
  },

  // ---------- Household (optional — joining links existing incidents) ----------

  async getMyHouseholdId() {
    const { data: sessionData } = await getClient().auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return null;
    const { data, error } = await getClient()
      .from('household_members')
      .select('household_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? data.household_id : null;
  },

  async createHousehold() {
    const { data, error } = await getClient().rpc('create_my_household');
    if (error) throw error;
    return data;
  },

  async joinHousehold(code) {
    const { data, error } = await getClient().rpc('join_household', { code });
    if (error) throw error;
    return data;
  },

  // Attaches every one of this user's own incidents to a household once
  // they join/create one — otherwise an anonymous-then-joined user's
  // earlier incidents would stay orphaned (household_id null) forever.
  async attachMyIncidentsToHousehold(householdId) {
    const { data: sessionData } = await getClient().auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return;
    await getClient()
      .from('incidents')
      .update({ household_id: householdId })
      .eq('recorder_user_id', userId)
      .is('household_id', null);
  },

  async fetchHouseholdVehicles(householdId) {
    if (!householdId) return [];
    const { data, error } = await getClient()
      .from('vehicles')
      .select('id, nickname, registration')
      .eq('household_id', householdId)
      .eq('archived', false);
    if (error) throw error;
    return data;
  },

  async fetchHouseholdPeople(householdId) {
    if (!householdId) return [];
    const { data, error } = await getClient()
      .from('people')
      .select('id, nickname')
      .eq('household_id', householdId)
      .eq('archived', false);
    if (error) throw error;
    return data;
  },

  // ---------- Incidents ----------

  async createIncident(incidentType) {
    const payload = { incident_type: incidentType };
    return this.writeWithQueue('insert', 'incidents', payload);
  },

  async updateIncident(id, fields) {
    return this.writeWithQueue('update', 'incidents', fields, { id });
  },

  async fetchIncident(id) {
    const { data, error } = await getClient().from('incidents').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  },

  // Open incidents recorded by me, regardless of household — this is what
  // powers the "unfinished incident" banner.
  async fetchMyOpenIncidents() {
    const { data: sessionData } = await getClient().auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return [];
    const { data, error } = await getClient()
      .from('incidents')
      .select('*')
      .eq('recorder_user_id', userId)
      .eq('status', 'open')
      .order('started_at', { ascending: false });
    if (error) throw error;
    return data;
  },

  async fetchMyClosedIncidents() {
    const { data: sessionData } = await getClient().auth.getSession();
    const userId = sessionData.session?.user?.id;
    if (!userId) return [];
    const { data, error } = await getClient()
      .from('incidents')
      .select('*')
      .eq('recorder_user_id', userId)
      .eq('status', 'closed')
      .order('started_at', { ascending: false })
      .limit(20);
    if (error) throw error;
    return data;
  },

  async closeIncident(id) {
    return this.updateIncident(id, { status: 'closed', closed_at: new Date().toISOString() });
  },

  async reopenIncident(id) {
    return this.updateIncident(id, { status: 'open', closed_at: null });
  },

  // ---------- Incident party (other driver / witness / police / etc.) ----------

  async fetchParties(incidentId) {
    const { data, error } = await getClient()
      .from('incident_party')
      .select('*')
      .eq('incident_id', incidentId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  },

  async addParty(incidentId, fields) {
    return this.writeWithQueue('insert', 'incident_party', { incident_id: incidentId, ...fields });
  },

  async deleteParty(id) {
    const { error } = await getClient().from('incident_party').delete().eq('id', id);
    if (error) throw error;
  },

  // ---------- Photos ----------

  async fetchPhotos(incidentId) {
    const { data, error } = await getClient()
      .from('incident_photos')
      .select('*')
      .eq('incident_id', incidentId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data;
  },

  // file: a File/Blob. meta: { source, taken_at, location_lat, location_lng, has_exif_data }
  async addPhoto(incidentId, file, meta) {
    const ext = (file.name && file.name.includes('.')) ? file.name.split('.').pop() : 'jpg';
    const path = `${incidentId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: uploadError } = await getClient().storage.from('incident-photos').upload(path, file);
    if (uploadError) throw uploadError;
    const payload = { incident_id: incidentId, storage_path: path, ...meta };
    const { data, error } = await getClient().from('incident_photos').insert(payload).select().maybeSingle();
    if (error) throw error;
    return data;
  },

  async getPhotoUrl(storagePath) {
    const { data, error } = await getClient().storage.from('incident-photos').createSignedUrl(storagePath, 3600);
    if (error) throw error;
    return data.signedUrl;
  },

  async deletePhoto(id, storagePath) {
    await getClient().storage.from('incident-photos').remove([storagePath]);
    const { error } = await getClient().from('incident_photos').delete().eq('id', id);
    if (error) throw error;
  },

  // ---------- Offline queue (same pattern as MM/LM) ----------

  async writeWithQueue(op, table, payload, match) {
    try {
      return await this._write(op, table, payload, match);
    } catch (err) {
      if (!navigator.onLine) {
        this._enqueue({ op, table, payload, match });
        return { queued: true };
      }
      throw err;
    }
  },

  async _write(op, table, payload, match) {
    if (op === 'insert') {
      const { data, error } = await getClient().from(table).insert(payload).select().maybeSingle();
      if (error) throw error;
      return data;
    }
    if (op === 'update') {
      const { data, error } = await getClient().from(table).update(payload).match(match).select().maybeSingle();
      if (error) throw error;
      return data;
    }
  },

  _enqueue(item) {
    const queue = this._readQueue();
    queue.push({ ...item, queuedAt: Date.now() });
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  },

  _readQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
  },

  queueLength() { return this._readQueue().length; },

  async flushQueue() {
    const queue = this._readQueue();
    if (!queue.length) return { flushed: 0 };
    const remaining = [];
    let flushed = 0;
    for (const item of queue) {
      try { await this._write(item.op, item.table, item.payload, item.match); flushed++; }
      catch { remaining.push(item); }
    }
    localStorage.setItem(QUEUE_KEY, JSON.stringify(remaining));
    return { flushed, remaining: remaining.length };
  },
};
