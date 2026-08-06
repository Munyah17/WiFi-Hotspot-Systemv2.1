const api = async (url, options = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

async function checkSession() {
  const { user } = await api('/api/auth/me');
  const loggedIn = user && user.role === 'admin';
  document.getElementById('login-box').classList.toggle('hidden', loggedIn);
  document.getElementById('app-box').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    loadAll();
    setInterval(loadActive, 5000);
  }
}

document.getElementById('login-btn').addEventListener('click', async () => {
  try {
    await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        phone_number: document.getElementById('login-phone').value.trim(),
        password: document.getElementById('login-password').value,
      }),
    });
    checkSession();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
});

function loadAll() {
  loadRevenue();
  loadActive();
  loadRouterStatus();
  loadPackages();
  loadStaff();
}

async function loadRevenue() {
  const { total } = await api('/api/admin/revenue/today');
  document.getElementById('stat-revenue').textContent = `$${total.toFixed(2)}`;
  document.getElementById('stat-target').textContent = `${Math.min(100, Math.round((total / 50) * 100))}%`;
}

async function loadActive() {
  try {
    const active = await api('/api/admin/network/active');
    document.getElementById('stat-active').textContent = active.length;
    document.getElementById('active-table').innerHTML = active
      .map(
        (s) => `
        <tr class="border-t">
          <td class="py-1">${s.address || '-'}</td>
          <td>${s['mac-address'] || '-'}</td>
          <td>${s.uptime || '-'}</td>
          <td><button data-mac="${s['mac-address']}" class="kick-btn text-red-600 text-xs">Kick</button></td>
        </tr>`
      )
      .join('');
    document.querySelectorAll('.kick-btn').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await api(`/api/admin/network/kick/${btn.dataset.mac}`, { method: 'POST' });
        loadActive();
      })
    );
  } catch (err) {
    document.getElementById('stat-active').textContent = '—';
  }
}

async function loadRouterStatus() {
  const { connected } = await api('/api/admin/router/status');
  document.getElementById('stat-router').textContent = connected ? 'Online' : 'Offline';
}

async function loadPackages() {
  const packages = await api('/api/admin/packages');
  document.getElementById('packages-table').innerHTML = packages
    .map((p) => `<tr class="border-t"><td class="py-1">${p.name}</td><td>${Math.round(p.duration_seconds / 3600)}h</td><td>$${p.price.toFixed(2)}</td></tr>`)
    .join('');
}

async function loadStaff() {
  const staff = await api('/api/admin/staff');
  document.getElementById('staff-table').innerHTML = staff
    .map((s) => `<tr class="border-t"><td class="py-1">${s.full_name || '-'}</td><td>${s.phone_number}</td><td>${s.role}</td><td>${s.status}</td></tr>`)
    .join('');
}

document.getElementById('staff-add').addEventListener('click', async () => {
  try {
    await api('/api/admin/staff', {
      method: 'POST',
      body: JSON.stringify({
        phone_number: document.getElementById('staff-phone').value.trim(),
        full_name: document.getElementById('staff-name').value.trim(),
        password: document.getElementById('staff-password').value,
        role: document.getElementById('staff-role').value,
      }),
    });
    loadStaff();
  } catch (err) {
    alert(err.message);
  }
});

checkSession();
