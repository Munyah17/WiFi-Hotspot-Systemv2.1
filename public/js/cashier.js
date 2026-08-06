const api = async (url, options = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

let cachedPackages = [];

async function checkSession() {
  const { user } = await api('/api/auth/me');
  const loggedIn = user && (user.role === 'cashier' || user.role === 'admin');
  document.getElementById('login-box').classList.toggle('hidden', loggedIn);
  document.getElementById('app-box').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    loadPackages();
    loadRecent();
    loadShift();
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

// --- Shift ---

async function loadShift() {
  const { shift, totals, expectedCash } = await api('/api/cashier/shift/current');
  document.getElementById('shift-closed').classList.toggle('hidden', !!shift);
  document.getElementById('shift-open').classList.toggle('hidden', !shift);
  if (!shift) return;

  document.getElementById('shift-opening').textContent = `$${shift.opening_float.toFixed(2)}`;
  document.getElementById('shift-expected').textContent = `$${expectedCash.toFixed(2)}`;
  document.getElementById('shift-totals').textContent = (totals || [])
    .map((t) => `${t.payment_method}: $${t.total.toFixed(2)} (${t.count})`)
    .join(' · ') || 'No sales yet this shift';
}

document.getElementById('open-shift-btn').addEventListener('click', async () => {
  try {
    await api('/api/cashier/shift/open', {
      method: 'POST',
      body: JSON.stringify({ openingFloat: Number(document.getElementById('opening-float').value) || 0 }),
    });
    loadShift();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('close-shift-btn').addEventListener('click', async () => {
  const counted = Number(document.getElementById('closing-counted').value) || 0;
  try {
    const shift = await api('/api/cashier/shift/close', { method: 'POST', body: JSON.stringify({ closingCounted: counted }) });
    const variance = counted - (Number(document.getElementById('shift-expected').textContent.replace('$', '')) || 0);
    alert(`Shift closed. Variance: ${variance >= 0 ? '+' : ''}$${variance.toFixed(2)}`);
    loadShift();
  } catch (err) {
    alert(err.message);
  }
});

// --- Packages / cash sale ---

async function loadPackages() {
  cachedPackages = await api('/portal/packages');
  document.getElementById('packages').innerHTML = cachedPackages
    .map(
      (p) => `
      <button data-id="${p.id}" class="sell-btn w-full border rounded-lg p-3 flex justify-between items-center text-left hover:bg-slate-50">
        <span>${p.name}</span><span class="font-bold">$${p.price.toFixed(2)}</span>
      </button>`
    )
    .join('');
  document.querySelectorAll('.sell-btn').forEach((btn) => btn.addEventListener('click', () => sellVoucher(btn.dataset.id)));

  document.getElementById('cd-extend-package').innerHTML = cachedPackages
    .map((p) => `<option value="${p.id}">${p.name} — $${p.price.toFixed(2)}</option>`)
    .join('');
}

async function sellVoucher(packageId) {
  try {
    const { voucher } = await api('/api/cashier/vouchers', { method: 'POST', body: JSON.stringify({ packageId }) });
    document.getElementById('receipt').classList.remove('hidden');
    document.getElementById('receipt-code').textContent = voucher.code;
    document.getElementById('receipt-package').textContent = `Duration: ${Math.round(voucher.duration_seconds / 3600)}h`;
    document.getElementById('receipt-price').textContent = `Paid: $${voucher.price.toFixed(2)} cash`;
    loadRecent();
    loadShift();
  } catch (err) {
    alert(err.message);
  }
}

async function loadRecent() {
  const recent = await api('/api/cashier/vouchers/recent');
  document.getElementById('recent').innerHTML = recent
    .map((v) => `<div class="flex justify-between"><span>${v.code}</span><span>$${v.price.toFixed(2)} — ${v.status}</span></div>`)
    .join('');
}

// --- Customer lookup ---

document.getElementById('customer-search-btn').addEventListener('click', searchCustomers);
document.getElementById('customer-search').addEventListener('keydown', (e) => e.key === 'Enter' && searchCustomers());

async function searchCustomers() {
  const phone = document.getElementById('customer-search').value.trim();
  const results = await api(`/api/cashier/customers/search?phone=${encodeURIComponent(phone)}`);
  document.getElementById('customer-results').innerHTML = results
    .map(
      (c) => `
      <button data-id="${c.id}" class="customer-result w-full flex justify-between items-center border rounded-lg p-2 text-left hover:bg-slate-50">
        <span>${c.full_name || c.phone_number} <span class="text-slate-400">${c.phone_number}</span></span>
        <span class="text-xs ${c.status === 'active' ? 'text-emerald-600' : 'text-red-600'}">${c.status}</span>
      </button>`
    )
    .join('') || '<p class="text-slate-500">No matches</p>';
  document.querySelectorAll('.customer-result').forEach((btn) => btn.addEventListener('click', () => openCustomer(btn.dataset.id)));
}

let currentCustomerId = null;

async function openCustomer(id) {
  const { customer, devices, voucherHistory } = await api(`/api/cashier/customers/${id}`);
  currentCustomerId = customer.id;
  document.getElementById('customer-detail').classList.remove('hidden');
  document.getElementById('cd-name').textContent = customer.full_name || customer.phone_number;
  document.getElementById('cd-phone').textContent = customer.phone_number;
  document.getElementById('cd-status').textContent = customer.status;
  document.getElementById('cd-loyalty').textContent = customer.loyalty_points;
  document.getElementById('cd-devices').textContent = devices.length;
  const toggleBtn = document.getElementById('cd-toggle-status');
  toggleBtn.textContent = customer.status === 'active' ? 'Suspend Customer' : 'Activate Customer';
  toggleBtn.onclick = () => setCustomerStatus(customer.status === 'active' ? 'suspended' : 'active');

  document.getElementById('cd-history').innerHTML = voucherHistory
    .map((v) => `<div class="flex justify-between border rounded-lg p-2"><span>${v.code}</span><span>${v.status}${v.session_status ? ' / ' + v.session_status : ''}</span></div>`)
    .join('') || '<p class="text-slate-500">No vouchers yet</p>';
}

document.getElementById('cd-close').addEventListener('click', () => {
  document.getElementById('customer-detail').classList.add('hidden');
  currentCustomerId = null;
});

async function setCustomerStatus(status) {
  await api(`/api/cashier/customers/${currentCustomerId}/status`, { method: 'POST', body: JSON.stringify({ status }) });
  openCustomer(currentCustomerId);
  searchCustomers();
}

document.getElementById('cd-loyalty-plus').addEventListener('click', () => adjustLoyalty(1));
document.getElementById('cd-loyalty-minus').addEventListener('click', () => adjustLoyalty(-1));

async function adjustLoyalty(delta) {
  await api(`/api/cashier/customers/${currentCustomerId}/loyalty`, { method: 'POST', body: JSON.stringify({ delta }) });
  openCustomer(currentCustomerId);
}

document.getElementById('cd-extend-btn').addEventListener('click', async () => {
  const packageId = document.getElementById('cd-extend-package').value;
  try {
    const { voucher } = await api(`/api/cashier/customers/${currentCustomerId}/extend`, {
      method: 'POST',
      body: JSON.stringify({ packageId }),
    });
    alert(`Voucher credited: ${voucher.code}`);
    openCustomer(currentCustomerId);
    loadShift();
  } catch (err) {
    alert(err.message);
  }
});

checkSession();
