(() => {
  const q = (id) => document.getElementById(id);
  const btn = q('queryBtn');
  const statusEl = q('status');
  const metrics = q('metrics');
  const adviceEl = q('advice');
  const offlineEl = q('offline');

  function showStatus(text, loading=false) {
    statusEl.textContent = text;
    statusEl.className = loading ? 'muted loading' : 'muted';
  }

  function render(data) {
    q('city').textContent = data.city || '未知';
    q('temp').textContent = `${data.weather?.temp ?? '-'}℃`;
    q('humidity').textContent = `${data.weather?.humidity ?? '-'}%`;
    q('precip').textContent = `${data.weather?.precipProbability ?? '-'}%`;
    q('wind').textContent = `${data.weather?.windScale ?? '-'}级`;
    q('source').textContent = `${data.source}${data.cached ? '（缓存）' : ''}`;
    metrics.style.display = 'grid';
    adviceEl.innerHTML = '';
    (data.advice || []).forEach(t => {
      const li = document.createElement('li');
      li.textContent = t;
      adviceEl.appendChild(li);
    });
  }

  async function fetchWeather(city) {
    const url = new URL('/api/weather', location.origin);
    if (city) url.searchParams.set('city', city);
    showStatus('查询中…', true);
    btn.disabled = true;
    try {
      const r = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('网络错误');
      const data = await r.json();
      render(data);
      showStatus(`更新于 ${new Date(data.timestamp).toLocaleString()}`);
    } catch (e) {
      showStatus('网络不可用，尝试读取离线数据…', true);
      try {
        const cached = await caches.match(url.toString());
        if (cached) {
          const data = await cached.json();
          render(data);
          showStatus(`离线数据（${new Date(data.timestamp).toLocaleString()}）`);
        } else {
          showStatus('暂无离线数据');
        }
      } catch (_) {
        showStatus('离线读取失败');
      }
    } finally {
      btn.disabled = false;
    }
  }

  btn.addEventListener('click', () => {
    const city = q('cityInput').value.trim();
    fetchWeather(city);
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }

  function updateOnline() {
    if (navigator.onLine) offlineEl.textContent = '';
    else offlineEl.textContent = '当前离线模式：可查看最近一次天气数据';
  }
  window.addEventListener('online', updateOnline);
  window.addEventListener('offline', updateOnline);
  updateOnline();

  fetchWeather('');
})();

