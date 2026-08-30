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
  loadInventory();
  loadSales();
  loadAuditLog();
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
  document.getElementById('batch-package').innerHTML = packages
    .filter((p) => p.active)
    .map((p) => `<option value="${p.id}">${p.name} — $${p.price.toFixed(2)}</option>`)
    .join('');
}

// --- Bulk voucher generation ---

document.getElementById('batch-generate').addEventListener('click', async () => {
  const packageId = document.getElementById('batch-package').value;
  const quantity = Number(document.getElementById('batch-quantity').value);
  const btn = document.getElementById('batch-generate');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const { vouchers, package: pkg } = await api('/api/admin/vouchers/batch', {
      method: 'POST',
      body: JSON.stringify({ packageId, quantity }),
    });
    document.getElementById('batch-result').textContent = `${vouchers.length} vouchers generated (${pkg.name}, $${pkg.price.toFixed(2)} each).`;
    document.getElementById('batch-preview').innerHTML = vouchers
      .slice(0, 12)
      .map((v) => `<div class="border rounded px-2 py-1 bg-slate-50">${v.code}</div>`)
      .join('') + (vouchers.length > 12 ? `<div class="text-slate-400 px-2 py-1">+${vouchers.length - 12} more…</div>` : '');
    document.getElementById('batch-print').classList.remove('hidden');
    preparePrintSheet(vouchers, pkg);
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate';
  }
});

function preparePrintSheet(vouchers, pkg) {
  document.getElementById('print-batch-summary').textContent =
    `${pkg.name} — ${Math.round(pkg.duration_seconds / 3600)}h access — $${pkg.price.toFixed(2)} — generated ${new Date().toLocaleString()}`;
  document.getElementById('print-voucher-grid').innerHTML = vouchers
    .map(
      (v) => `
      <div style="border:1px dashed #999;border-radius:6px;padding:8px;text-align:center;">
        <div style="font-size:11px;color:#555;">${pkg.name} — ${Math.round(pkg.duration_seconds / 3600)}h</div>
        <div style="font-family:monospace;font-weight:bold;font-size:14px;margin:4px 0;">${v.code}</div>
        <div style="font-size:10px;color:#777;">$${pkg.price.toFixed(2)} — connect to WiFi, enter this code</div>
      </div>`
    )
    .join('');
}

document.getElementById('batch-print').addEventListener('click', () => window.print());

// --- Staff ---

async function loadStaff() {
  const staff = await api('/api/admin/staff');
  document.getElementById('staff-table').innerHTML = staff
    .map(
      (s) => `
      <tr class="border-t">
        <td class="py-1">${s.full_name || '-'}</td><td>${s.phone_number}</td><td>${s.role}</td><td>${s.status}</td>
        <td class="text-right space-x-2">
          <button data-id="${s.id}" data-name="${s.full_name || ''}" data-role="${s.role}" class="staff-edit-btn text-xs text-slate-500">Edit</button>
          <button data-id="${s.id}" data-status="${s.status === 'active' ? 'suspended' : 'active'}" class="staff-status-btn text-xs ${s.status === 'active' ? 'text-red-600' : 'text-emerald-600'}">
            ${s.status === 'active' ? 'Suspend' : 'Activate'}
          </button>
        </td>
      </tr>`
    )
    .join('');

  document.querySelectorAll('.staff-status-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/api/admin/staff/${btn.dataset.id}/status`, { method: 'PUT', body: JSON.stringify({ status: btn.dataset.status }) });
      loadStaff();
    })
  );
  document.querySelectorAll('.staff-edit-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const full_name = prompt('Full name:', btn.dataset.name) ?? btn.dataset.name;
      const role = prompt('Role (admin/cashier):', btn.dataset.role) ?? btn.dataset.role;
      if (!['admin', 'cashier'].includes(role)) return alert('Role must be admin or cashier');
      try {
        await api(`/api/admin/staff/${btn.dataset.id}`, { method: 'PUT', body: JSON.stringify({ full_name, role }) });
        loadStaff();
      } catch (err) {
        alert(err.message);
      }
    })
  );
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

// --- Inventory ---

async function loadInventory() {
  const items = await api('/api/admin/inventory');
  document.getElementById('inventory-table').innerHTML = items
    .map(
      (i) => `
      <tr class="border-t">
        <td class="py-1">${i.item_name}</td><td>$${i.price.toFixed(2)}</td><td>${i.stock_quantity}</td>
        <td class="text-right"><button data-id="${i.id}" class="inv-sell-btn text-xs text-slate-900 border rounded px-2 py-0.5">Sell 1</button></td>
      </tr>`
    )
    .join('');
  document.querySelectorAll('.inv-sell-btn').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/admin/inventory/${btn.dataset.id}/sell`, { method: 'POST' });
        loadInventory();
        loadRevenue();
        loadSales();
      } catch (err) {
        alert(err.message);
      }
    })
  );
}

document.getElementById('inv-add').addEventListener('click', async () => {
  try {
    await api('/api/admin/inventory', {
      method: 'POST',
      body: JSON.stringify({
        item_name: document.getElementById('inv-name').value.trim(),
        price: Number(document.getElementById('inv-price').value) || 0,
        stock_quantity: Number(document.getElementById('inv-stock').value) || 0,
      }),
    });
    document.getElementById('inv-name').value = '';
    document.getElementById('inv-price').value = '';
    document.getElementById('inv-stock').value = '';
    loadInventory();
  } catch (err) {
    alert(err.message);
  }
});

// --- Sales / reports ---

async function loadSales() {
  const range = document.getElementById('sales-range').value;
  const { sales, total } = await api(`/api/admin/sales?range=${range}`);
  document.getElementById('sales-total').textContent = `$${total.toFixed(2)} (${sales.length} transactions)`;
  document.getElementById('sales-table').innerHTML = sales
    .map(
      (s) => `
      <tr class="border-t">
        <td class="py-1">${new Date(s.timestamp + 'Z').toLocaleString()}</td>
        <td>${s.transaction_type}</td>
        <td>${s.payment_method}</td>
        <td>$${s.amount.toFixed(2)}</td>
        <td>${s.voucher_code || '-'}</td>
        <td>${s.cashier_phone || s.customer_phone || '-'}</td>
      </tr>`
    )
    .join('');
}
document.getElementById('sales-range').addEventListener('change', loadSales);

// --- Audit log ---

async function loadAuditLog() {
  const rows = await api('/api/admin/audit-logs');
  document.getElementById('audit-table').innerHTML = rows
    .map(
      (r) => `
      <tr class="border-t">
        <td class="py-1">${new Date(r.created_at + 'Z').toLocaleString()}</td>
        <td>${r.actor_name || r.actor_phone || 'system'}</td>
        <td>${r.action}</td>
        <td>${r.target_type ? `${r.target_type} #${r.target_id}` : '-'}</td>
      </tr>`
    )
    .join('');
}

checkSession();
