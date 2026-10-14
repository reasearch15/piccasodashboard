'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const form = $('login-form'), error = $('login-error'), submit = $('login-submit'), password = $('password'), toggle = $('toggle-password');
  const showError = message => { error.textContent = message; error.classList.remove('hidden'); };

  toggle.onclick = () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-pressed', String(show));
  };

  form.onsubmit = async e => {
    e.preventDefault();
    const username = $('username').value.trim();
    if (!username || !password.value) return showError('Enter your username and password.');
    error.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = 'Logging in…';
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password: password.value }),
      });
      if (r.ok) return location.replace('/');
      const data = await r.json().catch(() => null);
      showError(r.status === 401 ? 'Invalid username or password.' : data?.error || 'Unable to log in. Please try again.');
    } catch {
      showError('Unable to reach the server. Check your connection and try again.');
    }
    password.value = '';
    password.focus();
    submit.disabled = false;
    submit.textContent = 'Log In';
  };
})();
