const api = async (url, options = {}) => {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};

async function checkSession() {
  const { user } = await api('/api/auth/me');
  const loggedIn = user && (user.role === 'cashier' || user.role === 'admin');
  document.getElementById('login-box').classList.toggle('hidden', loggedIn);
  document.getElementById('app-box').classList.toggle('hidden', !loggedIn);
  if (loggedIn) {
    loadPackages();
    loadRecent();
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

async function loadPackages() {
  const packages = await api('/portal/packages');
  document.getElementById('packages').innerHTML = packages
    .map(
      (p) => `
      <button data-id="${p.id}" class="sell-btn w-full border rounded-lg p-3 flex justify-between items-center text-left hover:bg-slate-50">
        <span>${p.name}</span><span class="font-bold">$${p.price.toFixed(2)}</span>
      </button>`
    )
    .join('');
  document.querySelectorAll('.sell-btn').forEach((btn) => btn.addEventListener('click', () => sellVoucher(btn.dataset.id)));
}

async function sellVoucher(packageId) {
  try {
    const { voucher } = await api('/api/cashier/vouchers', { method: 'POST', body: JSON.stringify({ packageId }) });
    document.getElementById('receipt').classList.remove('hidden');
    document.getElementById('receipt-code').textContent = voucher.code;
    document.getElementById('receipt-package').textContent = `Duration: ${Math.round(voucher.duration_seconds / 3600)}h`;
    document.getElementById('receipt-price').textContent = `Paid: $${voucher.price.toFixed(2)} cash`;
    loadRecent();
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

checkSession();
