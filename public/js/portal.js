const api = async (url, options = {}) => {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

function showBanner(message, kind = 'info') {
  const el = document.getElementById('status-banner');
  el.textContent = message;
  el.className = `mb-4 rounded-lg p-3 text-sm ${
    kind === 'error' ? 'bg-red-100 text-red-700' : kind === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200'
  }`;
}

// Disables a button and swaps its label while an async action runs, so a slow
// mobile-data round trip (common for USSD payment approval) can't be double-tapped.
async function withLoading(btn, busyLabel, fn) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyLabel;
  try {
    await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

// --- Tabs ---
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('bg-slate-900', 'text-white'));
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.add('bg-white', 'border'));
    btn.classList.add('bg-slate-900', 'text-white');
    btn.classList.remove('bg-white', 'border');
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

// --- Logging the device into the MikroTik hotspot once a voucher is active ---
let routerHost = null;
async function getRouterHost() {
  if (!routerHost) routerHost = (await api('/portal/router-host')).host;
  return routerHost;
}

async function loginToHotspot(mikrotikUsername) {
  const host = await getRouterHost();
  const form = document.getElementById('mikrotik-login-form');
  form.action = `http://${host}/login`;
  document.getElementById('mikrotik-username').value = mikrotikUsername;
  document.getElementById('mikrotik-password').value = mikrotikUsername;
  form.submit();
}

function onVoucherActivated(voucher) {
  showBanner("You're connected! Enjoy your browsing.", 'success');
  loginToHotspot(voucher.mikrotik_username);
}

// --- Packages / Buy ---
let selectedPackage = null;

async function loadPackages() {
  const packages = await api('/portal/packages');
  const container = document.getElementById('packages');
  container.innerHTML = packages
    .map(
      (p) => `
      <button data-id="${p.id}" class="pkg-btn w-full bg-white rounded-xl p-4 shadow-sm flex justify-between items-center text-left transition active:scale-[0.98] active:bg-slate-50">
        <span>
          <span class="block font-semibold">${p.name}</span>
          <span class="block text-sm text-slate-500">${formatDuration(p.duration_seconds)}</span>
        </span>
        <span class="text-lg font-bold">$${p.price.toFixed(2)}</span>
      </button>`
    )
    .join('');
  container.querySelectorAll('.pkg-btn').forEach((btn) => {
    btn.addEventListener('click', () => openPayModal(packages.find((p) => p.id === Number(btn.dataset.id))));
  });
}

function formatDuration(seconds) {
  if (seconds % (24 * 3600) === 0) return `${seconds / (24 * 3600)} day(s) of access`;
  return `${Math.round(seconds / 3600)} hour(s) of access`;
}

// --- Pay modal ---
const payModal = document.getElementById('pay-modal');
const paySubmitBtn = document.getElementById('pay-submit');
let selectedMethod = 'ecocash';
let pollTimer = null;

function selectMethod(method) {
  selectedMethod = method;
  document.querySelectorAll('.pay-method-btn').forEach((b) => {
    const active = b.dataset.method === method;
    b.classList.toggle('bg-slate-900', active);
    b.classList.toggle('text-white', active);
    b.classList.toggle('bg-white', !active);
    b.classList.toggle('border', !active);
  });
  document.getElementById('pay-mobile-fields').classList.toggle('hidden', method === 'stripe');
}

function openPayModal(pkg) {
  selectedPackage = pkg;
  document.getElementById('pay-title').textContent = `Pay $${pkg.price.toFixed(2)} — ${pkg.name}`;
  document.getElementById('pay-instructions').textContent = '';
  document.getElementById('pay-phone').value = '';
  selectMethod('ecocash');
  payModal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
}

function closePayModal() {
  payModal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

document.getElementById('pay-cancel').addEventListener('click', closePayModal);
document.getElementById('pay-close').addEventListener('click', closePayModal);
document.getElementById('pay-backdrop').addEventListener('click', closePayModal);

document.querySelectorAll('.pay-method-btn').forEach((btn) => {
  btn.addEventListener('click', () => selectMethod(btn.dataset.method));
});

paySubmitBtn.addEventListener('click', () =>
  withLoading(paySubmitBtn, 'Processing…', async () => {
    try {
      if (selectedMethod === 'stripe') {
        const { checkoutUrl } = await api('/portal/pay/stripe/initiate', {
          method: 'POST',
          body: JSON.stringify({ packageId: selectedPackage.id }),
        });
        window.location.href = checkoutUrl;
        return;
      }

      const phone = document.getElementById('pay-phone').value.trim();
      if (!phone) return showBanner('Enter your mobile money number', 'error');

      const { paymentRequestId, instructions } = await api('/portal/pay/paynow/initiate', {
        method: 'POST',
        body: JSON.stringify({ packageId: selectedPackage.id, phone, method: selectedMethod }),
      });
      document.getElementById('pay-instructions').textContent = instructions;
      pollPaynowStatus(paymentRequestId);
    } catch (err) {
      showBanner(err.message, 'error');
    }
  })
);

async function pollPaynowStatus(paymentRequestId) {
  pollTimer = setInterval(async () => {
    try {
      const result = await api(`/portal/pay/paynow/status/${paymentRequestId}`);
      if (result.status === 'paid') {
        closePayModal();
        onVoucherActivated(result.voucher);
      } else if (result.status === 'failed' || result.status === 'cancelled') {
        clearInterval(pollTimer);
        pollTimer = null;
        showBanner('Payment was not completed', 'error');
      }
    } catch (err) {
      clearInterval(pollTimer);
      pollTimer = null;
      showBanner(err.message, 'error');
    }
  }, 3000);
}

// --- Redeem code ---
const redeemBtn = document.getElementById('redeem-btn');
redeemBtn.addEventListener('click', () =>
  withLoading(redeemBtn, 'Connecting…', async () => {
    const code = document.getElementById('redeem-code').value.trim().toUpperCase();
    try {
      const result = await api('/portal/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code }) });
      onVoucherActivated(result.voucher);
    } catch (err) {
      showBanner(err.message, 'error');
    }
  })
);

// --- Account: login / register ---
let authMode = 'login';
const showLoginBtn = document.getElementById('show-login');
const showRegisterBtn = document.getElementById('show-register');
const authNameField = document.getElementById('auth-name');

function setAuthMode(mode) {
  authMode = mode;
  showLoginBtn.classList.toggle('bg-slate-900', mode === 'login');
  showLoginBtn.classList.toggle('text-white', mode === 'login');
  showLoginBtn.classList.toggle('bg-white', mode !== 'login');
  showLoginBtn.classList.toggle('border', mode !== 'login');
  showRegisterBtn.classList.toggle('bg-slate-900', mode === 'register');
  showRegisterBtn.classList.toggle('text-white', mode === 'register');
  showRegisterBtn.classList.toggle('bg-white', mode !== 'register');
  showRegisterBtn.classList.toggle('border', mode !== 'register');
  authNameField.classList.toggle('hidden', mode !== 'register');
}
setAuthMode('login');
showLoginBtn.addEventListener('click', () => setAuthMode('login'));
showRegisterBtn.addEventListener('click', () => setAuthMode('register'));

const authSubmitBtn = document.getElementById('auth-submit');
authSubmitBtn.addEventListener('click', () =>
  withLoading(authSubmitBtn, 'Please wait…', async () => {
    const phone_number = document.getElementById('auth-phone').value.trim();
    const password = document.getElementById('auth-password').value;
    const full_name = document.getElementById('auth-name').value.trim();
    try {
      const endpoint = authMode === 'login' ? '/api/auth/login' : '/api/auth/register';
      await api(endpoint, { method: 'POST', body: JSON.stringify({ phone_number, password, full_name }) });
      showBanner('Logged in', 'success');
      loadAccount();
    } catch (err) {
      showBanner(err.message, 'error');
    }
  })
);

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  loadAccount();
});

async function loadAccount() {
  const { user } = await api('/api/auth/me');
  document.getElementById('account-logged-out').classList.toggle('hidden', !!user);
  document.getElementById('account-logged-in').classList.toggle('hidden', !user);
  if (!user) return;

  document.getElementById('account-name').textContent = user.full_name || user.phone_number;
  document.getElementById('account-phone').textContent = user.phone_number;

  const { voucherHistory } = await api('/portal/account');
  const activeSessions = voucherHistory.filter((v) => v.session_status === 'active' || v.session_status === 'paused');
  document.getElementById('account-sessions').innerHTML = activeSessions
    .slice(0, 3)
    .map(
      (v) => `
      <div class="flex justify-between items-center border rounded-lg p-2 text-sm">
        <span>${v.code}</span>
        <button data-username="${v.mikrotik_username}" data-status="${v.session_status === 'active' ? 'pause' : 'continue'}"
          class="session-toggle min-h-9 px-4 py-2 rounded bg-slate-900 text-white text-sm transition active:scale-95">
          ${v.session_status === 'active' ? 'Pause' : 'Continue'}
        </button>
      </div>`
    )
    .join('');

  document.querySelectorAll('.session-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.status;
      await api(`/portal/sessions/${action}`, { method: 'POST', body: JSON.stringify({ mikrotikUsername: btn.dataset.username }) });
      loadAccount();
    });
  });
}

loadPackages();
loadAccount();
