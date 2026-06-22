// ── Auth manager ─────────────────────────────────────────────────────────────
const mwjAuth = (function() {
  const JWT_KEY    = 'mawjah_jwt';
  const _rawFetch  = window.fetch.bind(window);

  const EYE_OPEN   = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
  const EYE_CLOSED = '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';

  let _currentUser = null;
  let _tab = 'login'; // 'login' | 'register'

  const gate  = document.getElementById('mwj-gate');
  const errEl = document.getElementById('mwj-gate-error');
  const btn   = document.getElementById('mwj-submit-btn');

  function getToken()      { return localStorage.getItem(JWT_KEY) || ''; }
  function saveToken(t)    { localStorage.setItem(JWT_KEY, t); }
  function clearToken()    { localStorage.removeItem(JWT_KEY); }

  function setError(msg) { if (errEl) errEl.textContent = msg || ''; }

  function showGate(msg) {
    if (!gate) return;
    gate.classList.remove('gate-dismiss', 'gate-gone');
    setError(msg || '');
    setTimeout(() => { const f = document.getElementById('mwj-identifier'); if (f) f.focus(); }, 80);
  }

  function dismissGate() {
    if (!gate) return;
    gate.classList.add('gate-dismiss');
    gate.addEventListener('transitionend', () => gate.classList.add('gate-gone'), { once: true });
  }

  function switchTab(tab) {
    _tab = tab;
    const loginForm    = document.getElementById('mwj-login-form');
    const registerForm = document.getElementById('mwj-register-form');
    const loginBtn     = document.getElementById('tab-login-btn');
    const regBtn       = document.getElementById('tab-register-btn');
    if (tab === 'login') {
      loginForm.style.display = '';
      registerForm.style.display = 'none';
      loginBtn.classList.add('active');
      regBtn.classList.remove('active');
      if (btn) btn.textContent = 'Sign in';
    } else {
      loginForm.style.display = 'none';
      registerForm.style.display = '';
      loginBtn.classList.remove('active');
      regBtn.classList.add('active');
      if (btn) btn.textContent = 'Create account';
    }
    setError('');
  }

  function toggleVis(inputId, iconId) {
    const input = document.getElementById(inputId);
    const icon  = document.getElementById(iconId);
    if (!input || !icon) return;
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    icon.innerHTML = hidden ? EYE_CLOSED : EYE_OPEN;
  }

  async function submit() {
    if (!btn) return;
    setError('');
    btn.disabled = true;

    try {
      let res, data;
      if (_tab === 'login') {
        btn.textContent = 'Signing in…';
        const identifier = document.getElementById('mwj-identifier')?.value.trim() || '';
        const password   = document.getElementById('mwj-password')?.value || '';
        if (!identifier || !password) { setError('Email/username and password are required.'); return; }
        res  = await _rawFetch('/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ identifier, password }) });
        data = await res.json();
      } else {
        btn.textContent = 'Creating account…';
        const email       = document.getElementById('mwj-reg-email')?.value.trim() || '';
        const username    = document.getElementById('mwj-reg-username')?.value.trim() || '';
        const display_name= document.getElementById('mwj-reg-displayname')?.value.trim() || '';
        const password    = document.getElementById('mwj-reg-password')?.value || '';
        if (!email && !username) { setError('Enter an email or username.'); return; }
        if (!password) { setError('Password is required.'); return; }
        res  = await _rawFetch('/auth/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, username, display_name, password }) });
        data = await res.json();
      }

      if (!res.ok) { setError(data.error || 'Something went wrong.'); return; }
      saveToken(data.token);
      _currentUser = data.user;
      updateUserUI(data.user);
      dismissGate();
    } finally {
      btn.disabled = false;
      btn.textContent = _tab === 'login' ? 'Sign in' : 'Create account';
    }
  }

  function updateUserUI(user) {
    if (!user) return;
    const menu = document.getElementById('user-menu');
    if (menu) menu.style.display = '';
    const avatarBtn = document.getElementById('user-avatar-btn');
    if (avatarBtn) {
      if (user.avatar_url) {
        avatarBtn.innerHTML = `<img src="${user.avatar_url}" alt="">`;
      } else {
        const initials = (user.display_name || user.username || user.email || '?').slice(0,2).toUpperCase();
        avatarBtn.textContent = initials;
      }
    }
    const ddName  = document.getElementById('dd-display-name');
    const ddEmail = document.getElementById('dd-email');
    if (ddName)  ddName.textContent  = user.display_name || user.username || 'User';
    if (ddEmail) ddEmail.textContent = user.email || user.username || '';
  }

  async function logout() {
    await _rawFetch('/auth/logout', { method:'POST' }).catch(() => {});
    clearToken();
    _currentUser = null;
    const menu = document.getElementById('user-menu');
    if (menu) menu.style.display = 'none';
    document.getElementById('user-dropdown')?.classList.remove('open');
    switchTab('login');
    showGate();
  }

  // Patch window.fetch — injects JWT on /api/ calls
  window.fetch = function(resource, init) {
    const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
    if (url.startsWith('/api/')) {
      const token = getToken();
      init = Object.assign({}, init);
      init.headers = Object.assign({ 'Authorization': 'Bearer ' + token }, init.headers || {});
    }
    return _rawFetch(resource, init).then(function(r) {
      if (r.status === 401 && url.startsWith('/api/')) {
        clearToken();
        _currentUser = null;
        document.getElementById('user-menu')?.style.setProperty('display','none');
        showGate('Session expired — please sign in again.');
      }
      return r;
    });
  };

  // ── Initialise ─────────────────────────────────────────────────────────────
  // 1. Handle OAuth redirect: ?auth_code=... (one-time code, never the JWT itself)
  const urlParams = new URLSearchParams(window.location.search);
  const oauthCode = urlParams.get('auth_code');
  const oauthError = urlParams.get('auth_error');
  if (oauthCode) {
    // Exchange the short-lived code for a JWT (keeps JWT out of logs/history)
    window.history.replaceState({}, '', window.location.pathname);
    _rawFetch('/auth/exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: oauthCode }) })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.token) saveToken(d.token); })
      .catch(() => {});
  }
  if (oauthError) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  // 2. Validate stored token
  const stored = getToken();
  if (stored) {
    gate?.classList.add('gate-gone'); // optimistic hide
    _rawFetch('/auth/me', { headers: { Authorization: 'Bearer ' + stored } })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(d => {
        _currentUser = d.user;
        updateUserUI(d.user);
      })
      .catch(() => {
        clearToken();
        showGate(oauthError ? `Google sign-in failed: ${oauthError}` : '');
      });
  } else if (oauthError) {
    showGate(`Google sign-in failed: ${decodeURIComponent(oauthError)}`);
  }

  // 3. Wire Enter key
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && gate && !gate.classList.contains('gate-gone') && !gate.classList.contains('gate-dismiss')) {
      submit();
    }
  });

  return { submit, switchTab, toggleVis, showGate, dismissGate, logout, get currentUser() { return _currentUser; } };
})();

// ── User dropdown ─────────────────────────────────────────────────────────────
function toggleUserDropdown() {
  document.getElementById('user-dropdown')?.classList.toggle('open');
}
document.addEventListener('click', e => {
  const menu = document.getElementById('user-menu');
  if (menu && !menu.contains(e.target)) {
    document.getElementById('user-dropdown')?.classList.remove('open');
  }
});

// ── Profile modal ─────────────────────────────────────────────────────────────
function openProfileModal() {
  document.getElementById('user-dropdown')?.classList.remove('open');
  const user = mwjAuth.currentUser;
  if (!user) return;
  document.getElementById('profile-display-name').value = user.display_name || '';
  document.getElementById('profile-username').value = user.username || '';
  document.getElementById('profile-avatar-url').value = user.avatar_url || '';
  const preview = document.getElementById('profile-avatar-preview');
  if (user.avatar_url) {
    preview.innerHTML = `<img src="${user.avatar_url}" alt="">`;
  } else {
    preview.textContent = (user.display_name || user.username || '?').slice(0,2).toUpperCase();
  }
  document.getElementById('profile-modal-overlay').classList.add('open');
}
function closeProfileModal() {
  document.getElementById('profile-modal-overlay')?.classList.remove('open');
}
async function saveProfile() {
  const display_name = document.getElementById('profile-display-name').value.trim();
  const username     = document.getElementById('profile-username').value.trim();
  const avatar_url   = document.getElementById('profile-avatar-url').value.trim();
  const token = localStorage.getItem('mawjah_jwt') || '';
  const res = await fetch('/auth/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: JSON.stringify({ display_name: display_name || undefined, username: username || undefined, avatar_url: avatar_url || undefined }),
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Failed to save.'); return; }
  closeProfileModal();
  mwjAuth.showGate && undefined; // just refresh UI
  // Re-fetch user to update header
  fetch('/auth/me', { headers: { Authorization: 'Bearer ' + token } })
    .then(r => r.json()).then(d => {
      const avatarBtn = document.getElementById('user-avatar-btn');
      const ddName    = document.getElementById('dd-display-name');
      const ddEmail   = document.getElementById('dd-email');
      if (d.user) {
        if (d.user.avatar_url) { avatarBtn.innerHTML = `<img src="${d.user.avatar_url}" alt="">`; }
        else { avatarBtn.textContent = (d.user.display_name || d.user.username || '?').slice(0,2).toUpperCase(); }
        if (ddName)  ddName.textContent  = d.user.display_name || d.user.username || 'User';
        if (ddEmail) ddEmail.textContent = d.user.email || d.user.username || '';
      }
    }).catch(() => {});
}