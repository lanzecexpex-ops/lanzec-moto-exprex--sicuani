(function () {
  'use strict';

  var C = window.LANZEC_CONFIG || {};
  var page = document.body.dataset.page;
  var sb = null;

  /* ---------- utilidades ---------- */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var money = function (n) { return 'S/ ' + Number(n).toFixed(2); };
  var fdate = function (d) { return new Date(d).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }); };
  var TYPE = { mototaxi: 'Mototaxi', delivery: 'Delivery' };
  var ST = {
    requested: 'Recibiendo ofertas', accepted: 'Aceptado',
    in_progress: 'En curso', completed: 'Completado', cancelled: 'Cancelado'
  };
  var PANEL = { admin: 'admin.html', transporter: 'transportista.html', client: 'cliente.html' };
  var PLANS = {
    client: [
      { id: 'weekly', label: 'Semanal', days: 7, price: 2 },
      { id: 'monthly', label: 'Mensual', days: 30, price: 10 }
    ],
    transporter: [
      { id: 'weekly', label: 'Semanal', days: 7, price: 8 },
      { id: 'monthly', label: 'Mensual', days: 30, price: 25 }
    ]
  };

  var noticeTimer;
  function notice(msg, bad) {
    var n = $('#notice');
    if (!n) { alert(msg); return; }
    n.textContent = msg;
    n.className = 'notice' + (bad ? ' bad' : '');
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { n.hidden = true; }, bad ? 12000 : 8000);
  }

  function friendly(e) {
    var m = (e && e.message) || String(e);
    if (/Invalid login credentials/i.test(m)) return 'Correo o contraseña incorrectos.';
    if (/Email not confirmed/i.test(m)) return 'Debes confirmar tu correo antes de entrar. Revisa tu bandeja de entrada.';
    if (/already registered|already been registered/i.test(m)) return 'Ese correo ya está registrado. Inicia sesión.';
    if (/Database error saving new user/i.test(m)) return 'No se pudo crear la cuenta. Verifica que el DNI no esté ya registrado y que los datos sean válidos.';
    if (/rate limit|too many/i.test(m)) return 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.';
    if (/row-level security|permission denied/i.test(m)) return 'No tienes permiso para esta acción. Revisa que tu cuenta esté aprobada y tu suscripción activa.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Sin conexión con el servidor. Inténtalo de nuevo.';
    return m;
  }

  function withBusy(form, fn) {
    var b = $('button[type=submit]', form);
    if (b) b.disabled = true;
    return Promise.resolve().then(fn).catch(function (e) { notice(friendly(e), true); })
      .then(function () { if (b) b.disabled = !!form.querySelector('#pendingNote'); });
  }

  async function rpc(name, args) {
    var r = await sb.rpc(name, args);
    if (r.error) throw r.error;
    return r.data;
  }

  /* ---------- sesión / perfil ---------- */
  async function session() { return (await sb.auth.getSession()).data.session; }
  async function myProfile(uid) {
    var r = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (r.error) throw r.error;
    return r.data;
  }
  async function guard(roles) {
    var s = await session();
    if (!s) { location.replace('login.html'); return null; }
    var p = await myProfile(s.user.id);
    if (!p) { await sb.auth.signOut(); location.replace('login.html'); return null; }
    if (roles && roles.indexOf(p.role) < 0) { location.replace(PANEL[p.role]); return null; }
    return { user: s.user, profile: p };
  }
  function statusBlock(p) {
    return {
      pending: 'Tu cuenta está pendiente de aprobación por administración.',
      suspended: 'Tu cuenta está suspendida. Contacta a administración.',
      rejected: 'Tu solicitud fue rechazada. Contacta a administración.'
    }[p.account_status] || null;
  }
  function adaptNav(p) {
    var nav = $('nav');
    if (!nav || !p) return;
    if (p.role === 'admin') $$('a[href="suscripcion.html"]', nav).forEach(function (a) { a.remove(); });
    var here = location.pathname.split('/').pop() || 'index.html';
    var lo = $('[data-logout]', nav);
    if (here !== PANEL[p.role] && !$('a[data-panel]', nav)) {
      var a = document.createElement('a');
      a.className = 'btn ghost small'; a.href = PANEL[p.role]; a.textContent = 'Mi panel'; a.setAttribute('data-panel', '1');
      nav.insertBefore(a, lo);
    }
    if (lo) lo.style.display = '';
  }

  /* ---------- cuenta regresiva de suscripción ---------- */
  var cdTimer;
  async function countdown(uid) {
    var el = $('#countdown');
    var r = await sb.from('subscriptions').select('expires_at').eq('user_id', uid).eq('status', 'active')
      .order('expires_at', { ascending: false }).limit(1);
    var exp = r.data && r.data[0] ? new Date(r.data[0].expires_at) : null;
    clearInterval(cdTimer);
    function tick() {
      if (!el) return !!exp && exp > Date.now();
      if (!exp) { el.textContent = 'Sin suscripción activa'; return false; }
      var ms = exp - Date.now();
      if (ms <= 0) { el.textContent = 'Vencida'; return false; }
      var d = Math.floor(ms / 864e5), h = Math.floor(ms % 864e5 / 36e5),
        m = Math.floor(ms % 36e5 / 6e4), s = Math.floor(ms % 6e4 / 1e3);
      el.textContent = d + 'd ' + pad(h) + ':' + pad(m) + ':' + pad(s);
      return true;
    }
    var active = tick();
    if (active) cdTimer = setInterval(function () { if (!tick()) clearInterval(cdTimer); }, 1000);
    return active;
  }

  /* ---------- fotos ---------- */
  function checkPhoto(f) {
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) throw new Error('La foto debe ser JPG, PNG o WEBP.');
    if (f.size > 5 * 1024 * 1024) throw new Error('La foto supera 5 MB.');
  }
  async function uploadPhoto(file, uid) {
    checkPhoto(file);
    var ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    var path = uid + '/' + crypto.randomUUID() + '.' + ext;
    var r = await sb.storage.from('profile-photos').upload(path, file, { contentType: file.type, cacheControl: '3600' });
    if (r.error) throw r.error;
    await rpc('set_my_photo', { p_path: path });
    return path;
  }
  function photoUrl(path) { return sb.storage.from('profile-photos').getPublicUrl(path).data.publicUrl; }

  var zoomReady = false;
  function enablePhotoZoom() {
    if (zoomReady) return;
    zoomReady = true;
    var st = document.createElement('style');
    st.textContent = '.photo-zoom{position:fixed;inset:0;z-index:100;background:#000d;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:16px;cursor:zoom-out}' +
      '.photo-zoom img{max-width:min(92vw,560px);max-height:78vh;border-radius:16px;border:2px solid var(--cyan);object-fit:contain;background:#081626}' +
      '.photo-zoom span{color:#fff;font-weight:700;text-align:center}.photo-zoom small{color:#cfe}';
    document.head.appendChild(st);
    function close() { var o = document.querySelector('.photo-zoom'); if (o) o.remove(); }
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    document.addEventListener('click', function (e) {
      if (e.target.closest('.photo-zoom')) { close(); return; }
      var im = e.target.closest('img[data-zoom]');
      if (!im) return;
      close();
      var o = document.createElement('div');
      o.className = 'photo-zoom';
      o.innerHTML = '<img alt="" src="' + esc(im.dataset.zoom) + '"><span>' + esc(im.dataset.caption || '') + '</span><small>Toca para cerrar</small>';
      document.body.appendChild(o);
    });
  }

  /* ---------- helpers de servicios ---------- */
  function place(t) {
    var m = /(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(t || '');
    var s = esc(t);
    return m ? s + ' <a target="_blank" rel="noopener" href="https://www.google.com/maps?q=' + m[1] + ',' + m[2] + '">Ver en mapa</a>' : s;
  }
  function waLink(p) {
    var d = String(p || '').replace(/\D/g, '');
    if (d.length === 9) d = '51' + d;
    return 'https://wa.me/' + d;
  }
  function contactHtml(c) {
    if (!c) return '';
    var tel = String(c.phone || '').replace(/[^\d+]/g, '');
    return '<p><b>' + esc(c.name) + '</b> · <a href="tel:' + esc(tel) + '">' + esc(c.phone) +
      '</a> · <a target="_blank" rel="noopener" href="' + waLink(c.phone) + '">WhatsApp</a></p>' +
      (c.plate ? '<p class="muted">Moto: ' + esc(c.motorcycle) + ' · ' + esc(c.color) + ' · Placa ' + esc(c.plate) + '</p>' : '');
  }
  var contacts = new Map();
  async function loadContacts(list) {
    var need = list.filter(function (s) {
      return ['accepted', 'in_progress', 'completed'].indexOf(s.status) >= 0 && !contacts.has(s.id);
    });
    await Promise.all(need.map(async function (s) {
      var r = await sb.rpc('service_contact', { p_id: s.id });
      if (!r.error && r.data) contacts.set(s.id, r.data);
    }));
  }

  var ACTIONS = {
    'accept-offer': function (b) { return rpc('accept_offer', { p_offer: b.dataset.offer }); },
    'cancel': function (b) { return rpc('update_service_status', { p_id: b.dataset.id, p_status: 'cancelled' }); },
    'accept': function (b) { return rpc('accept_service', { p_id: b.dataset.id }); },
    'offer': function (b) {
      var v = parseFloat(b.closest('.service-card').querySelector('input').value);
      if (!(v >= 0.5 && v <= 500)) throw new Error('Ingresa una oferta entre S/ 0.50 y S/ 500.');
      return rpc('make_offer', { p_service: b.dataset.id, p_price: v });
    },
    'withdraw-offer': function (b) { return rpc('withdraw_offer', { p_service: b.dataset.id }); },
    'start': function (b) { return rpc('update_service_status', { p_id: b.dataset.id, p_status: 'in_progress' }); },
    'finish': function (b) { return rpc('update_service_status', { p_id: b.dataset.id, p_status: 'completed' }); }
  };
  var CONFIRM = {
    cancel: '¿Cancelar este servicio?', finish: '¿Marcar el servicio como finalizado?',
    'withdraw-offer': '¿Retirar tu oferta?', 'accept-offer': '¿Aceptar esta oferta? Se rechazarán las demás.',
    accept: '¿Aceptar este servicio al precio propuesto?'
  };

  function bindActions(container, refresh) {
    container.addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var a = b.dataset.act;
      if (CONFIRM[a] && !confirm(CONFIRM[a])) return;
      b.disabled = true;
      try {
        await ACTIONS[a](b);
        notice('Listo.');
        await refresh(true);
      } catch (err) {
        notice(friendly(err), true);
      } finally { b.disabled = false; }
    });
  }

  function poll(fn, ms) {
    var busy = false, failed = false;
    var run = async function (force) {
      if (busy || (document.hidden && !force)) return;
      busy = true;
      try { await fn(force === true); failed = false; }
      catch (e) { console.error(e); if (!failed) { failed = true; notice(friendly(e), true); } }
      finally { busy = false; }
    };
    run(true);
    setInterval(run, ms);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) run(true); });
    return run;
  }

  /* =====================================================================
     PÁGINAS
     ===================================================================== */

  async function homePage() {
    var s = await session();
    if (s) { var p = await myProfile(s.user.id); adaptNav(p); }
  }

  async function loginPage() {
    var s = await session();
    if (s) {
      var p0 = await myProfile(s.user.id);
      if (p0) { location.replace(PANEL[p0.role]); return; }
    }
    var f = $('#loginForm');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      withBusy(f, async function () {
        var r = await sb.auth.signInWithPassword({
          email: $('#email').value.trim().toLowerCase(), password: $('#password').value
        });
        if (r.error) throw r.error;
        var p = await myProfile(r.data.user.id);
        if (!p) throw new Error('No se encontró tu perfil. Contacta a administración.');
        location.href = PANEL[p.role];
      });
    });
  }

  function regPage(role) {
    var f = $('#registerForm');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      withBusy(f, async function () {
        var d = new FormData(f);
        var v = function (n) { return String(d.get(n) || '').trim(); };
        var pw = String(d.get('password') || '');
        if (pw.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres.');
        if (pw !== d.get('confirm_password')) throw new Error('Las contraseñas no coinciden.');
        if (!/^\d{8}$/.test(v('dni'))) throw new Error('El DNI debe tener exactamente 8 dígitos.');
        var age = parseInt(v('age'), 10);
        var minAge = role === 'transporter' ? 18 : 15;
        if (!(age >= minAge && age <= 100)) throw new Error('Debes tener al menos ' + minAge + ' años para registrarte.');
        if (!/^[0-9+\s-]{6,20}$/.test(v('phone'))) throw new Error('Ingresa un celular válido.');
        var meta = { role: role, full_name: v('full_name'), age: age, dni: v('dni'), phone: v('phone') };
        var file = null;
        if (role === 'transporter') {
          meta.motorcycle = v('motorcycle');
          meta.plate = v('plate').toUpperCase();
          meta.motorcycle_color = v('motorcycle_color');
          meta.service_types = d.getAll('service_types');
          if (!meta.service_types.length) throw new Error('Selecciona Mototaxi, Delivery o ambos.');
          file = f.profile_photo && f.profile_photo.files[0] ? f.profile_photo.files[0] : null;
          if (file) checkPhoto(file);
        }
        var r = await sb.auth.signUp({ email: v('email').toLowerCase(), password: pw, options: { data: meta } });
        if (r.error) throw r.error;
        if (r.data.user && r.data.user.identities && !r.data.user.identities.length)
          throw new Error('Ese correo ya está registrado. Inicia sesión.');
        if (r.data.session) {
          if (file) { try { await uploadPhoto(file, r.data.user.id); } catch (err) { console.error(err); } }
          notice('Cuenta creada. Ahora elige tu suscripción.');
          setTimeout(function () {
            location.href = 'suscripcion.html' + (role === 'transporter' ? '?role=transporter' : '');
          }, 900);
        } else {
          notice('Cuenta creada. Confirma tu correo y luego inicia sesión.');
          setTimeout(function () { location.href = 'login.html'; }, 3500);
        }
      });
    });
  }

  async function subscriptionPage() {
    var form = $('#subscriptionForm');
    var s = await session();
    if (!s) {
      notice('Inicia sesión para solicitar tu suscripción.', true);
      form.style.display = 'none';
      return;
    }
    var p = await myProfile(s.user.id);
    if (!p) { notice('No se encontró tu perfil.', true); return; }
    if (p.role === 'admin') { location.replace('admin.html'); return; }
    adaptNav(p);
    var PL = PLANS[p.role];
    $('#plans').innerHTML = PL.map(function (x, i) {
      return '<label class="plan"><input type="radio" name="plan" value="' + x.id + '"' + (i ? '' : ' checked') +
        '><span><b>' + x.label + '</b><small>' + x.days + ' días</small></span><strong>S/ ' + x.price + '</strong></label>';
    }).join('');
    if ($('#yapePhone') && C.YAPE_PHONE) $('#yapePhone').textContent = C.YAPE_PHONE;
    if ($('#yapeHolder') && C.YAPE_HOLDER) $('#yapeHolder').textContent = C.YAPE_HOLDER;

    var hist = document.createElement('section');
    hist.className = 'card';
    $('main').appendChild(hist);
    async function loadHist() {
      var r = await sb.from('subscriptions').select('*').eq('user_id', p.id).order('created_at', { ascending: false }).limit(10);
      if (r.error) throw r.error;
      var L = { pending: 'En revisión', active: 'Activa', rejected: 'Rechazada' };
      hist.innerHTML = '<h2>Mis solicitudes</h2>' + (r.data.length ? r.data.map(function (x) {
        return '<div class="service-card"><div class="row"><b>' + (x.plan === 'weekly' ? 'Semanal' : 'Mensual') + ' · ' + money(x.amount) +
          '</b><span class="pill">' + L[x.status] + '</span></div><small class="muted">Solicitada ' + fdate(x.created_at) +
          (x.status === 'active' ? ' · vence ' + fdate(x.expires_at) : '') + '</small></div>';
      }).join('') : '<div class="empty">Aún no tienes solicitudes.</div>');
    }
    loadHist().catch(function (e) { notice(friendly(e), true); });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      withBusy(form, async function () {
        var plan = new FormData(form).get('plan');
        var pl = PL.filter(function (x) { return x.id === plan; })[0];
        var id = await rpc('request_subscription', { p_plan: plan });
        var msg = 'Hola, quiero activar mi suscripción ' + pl.label + ' (S/ ' + pl.price + ') en LANZEC MOTO EXPRESS.\n' +
          'Nombre: ' + p.full_name + '\nDNI: ' + p.dni + '\nCelular: ' + p.phone + '\nCorreo: ' + p.email + '\nTipo de cuenta: ' + (p.role === 'client' ? 'Cliente' : 'Transportista') +
          '\nSolicitud: ' + String(id).slice(0, 8) + '\nAdjunto mi captura de pago de Yape' +
          (p.role === 'transporter' ? ' y la foto del frente de mi DNI.' : '.');
        var url = 'https://wa.me/' + (C.WHATSAPP || '') + '?text=' + encodeURIComponent(msg);
        var box = $('#waBox');
        if (!box) { box = document.createElement('div'); box.id = 'waBox'; box.className = 'card'; form.parentNode.appendChild(box); }
        box.innerHTML = '<p>✅ Solicitud registrada. Abre WhatsApp y adjunta manualmente tu captura de pago' +
          (p.role === 'transporter' ? ' y la foto de tu DNI' : '') + '.</p><a class="btn" target="_blank" rel="noopener" href="' + esc(url) + '">Abrir WhatsApp</a>';
        window.open(url, '_blank', 'noopener');
        await loadHist();
      });
    });
  }

  async function clientPage() {
    var g = await guard(['client']);
    if (!g) return;
    adaptNav(g.profile);
    $('#welcome').textContent = 'Hola, ' + g.profile.full_name.split(' ')[0];
    var blocked = statusBlock(g.profile);
    var hasSub = await countdown(g.user.id);
    var f = $('#requestForm');
    if (blocked) { notice(blocked, true); f.style.display = 'none'; return; }
    if (!hasSub) notice('No tienes suscripción activa. Para solicitar servicios, activa un plan en "Suscripciones".', true);

    $('#locate').addEventListener('click', function () {
      var b = $('#locate');
      if (!navigator.geolocation) return notice('Tu navegador no permite obtener la ubicación.', true);
      b.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        $('#origin').value = 'Ubicación GPS: ' + pos.coords.latitude.toFixed(6) + ', ' + pos.coords.longitude.toFixed(6);
        b.disabled = false;
        notice('Ubicación agregada. Puedes añadir una referencia para ayudar al transportista.');
      }, function () {
        b.disabled = false;
        notice('No se pudo obtener tu ubicación. Escribe la dirección manualmente.', true);
      }, { enableHighAccuracy: true, timeout: 10000 });
    });

    enablePhotoZoom();
    var box = $('#myServices'), lastSig = '';
    function offersHtml(list) {
      if (!list.length) return '<div class="details"><small class="muted">Aún no hay ofertas. Los transportistas pueden aceptar tu precio u ofertar otro. Se actualiza solo.</small></div>';
      return '<div class="details"><b>Ofertas recibidas (' + list.length + ')</b>' + list.map(function (o, i) {
        return '<div class="row" style="margin-top:10px;flex-wrap:wrap"><div style="display:flex;gap:10px;align-items:center">' +
          (o.photo_path ? '<img alt="Foto de ' + esc(o.transporter_name) + '" title="Toca para ver la foto" data-zoom="' + esc(photoUrl(o.photo_path)) + '" data-caption="' + esc(o.transporter_name) + '" src="' + esc(photoUrl(o.photo_path)) + '" style="width:56px;height:56px;border-radius:50%;object-fit:cover;border:2px solid var(--cyan);cursor:zoom-in">' : '') +
          '<div><b>' + esc(o.transporter_name) + '</b>' + (i === 0 && list.length > 1 ? ' <span class="badge">Mejor precio</span>' : '') +
          '<br><small class="muted">' + esc(o.motorcycle || '') + ' · ' + esc(o.color || '') + '</small></div></div>' +
          '<div style="display:flex;gap:10px;align-items:center"><strong style="font-size:1.3rem;color:var(--cyan)">' + money(o.price) +
          '</strong><button class="btn small" data-act="accept-offer" data-offer="' + o.offer_id + '" data-id="' + o.service_id + '">Aceptar</button></div></div>';
      }).join('') + '</div>';
    }
    function card(s, offers) {
      var c = contacts.get(s.id), actions = '';
      if (['requested', 'accepted'].indexOf(s.status) >= 0)
        actions = '<button class="btn danger small" data-act="cancel" data-id="' + s.id + '">Cancelar</button>';
      return '<div class="service-card"><div class="row"><span class="pill">' + TYPE[s.service_type] + '</span><span class="pill">' + ST[s.status] + '</span></div>' +
        '<p><b>' + place(s.origin) + '</b>' + (s.origin_reference ? ' <span class="muted">(' + esc(s.origin_reference) + ')</span>' : '') +
        '<br>→ ' + esc(s.destination) + '</p>' +
        '<p>' + (s.status === 'requested' ? 'Tu precio propuesto' : 'Precio acordado') + ': <b>' + money(s.final_price || s.proposed_price) + '</b> · Pago: ' + esc(s.payment_method) + '</p>' +
        (s.note ? '<p class="muted">' + esc(s.note) + '</p>' : '') +
        (s.status === 'requested' ? offersHtml(offers) : '') +
        (c ? '<div class="details">' + contactHtml(c) + '</div>' : '') +
        '<small class="muted">' + fdate(s.created_at) + '</small>' +
        (actions ? '<div class="actions">' + actions + '</div>' : '') + '</div>';
    }
    var refresh = poll(async function (force) {
      var r = await sb.from('services').select('*').eq('client_id', g.user.id).order('created_at', { ascending: false }).limit(50);
      if (r.error) throw r.error;
      var of = await sb.rpc('client_offers');
      if (of.error) throw of.error;
      var byS = {};
      (of.data || []).forEach(function (o) { (byS[o.service_id] = byS[o.service_id] || []).push(o); });
      await loadContacts(r.data);
      var pending = r.data.some(function (s) { return s.status === 'requested' || s.status === 'countered'; });
      var sbtn = $('button[type=submit]', f), pn = $('#pendingNote');
      if (sbtn) sbtn.disabled = pending;
      if (pending && !pn && sbtn) {
        sbtn.insertAdjacentHTML('beforebegin', '<p id="pendingNote" class="note">Ya tienes una solicitud en espera. Podrás pedir otro servicio cuando un transportista la acepte o la canceles.</p>');
      } else if (!pending && pn) pn.remove();
      var sig = JSON.stringify(r.data.map(function (s) { return [s.id, s.status, s.final_price]; })) +
        JSON.stringify((of.data || []).map(function (o) { return [o.offer_id, o.price]; })) + contacts.size;
      if (sig === lastSig && !force) return;
      lastSig = sig;
      box.innerHTML = r.data.length ? r.data.map(function (s) { return card(s, byS[s.id] || []); }).join('') : '<div class="empty">Aún no has solicitado servicios.</div>';
    }, 8000);
    bindActions(box, function () { lastSig = ''; return refresh(true); });

    f.addEventListener('submit', function (e) {
      e.preventDefault();
      withBusy(f, async function () {
        if ($('#pendingNote')) throw new Error('Ya tienes una solicitud en espera. Acéptala o cancélala antes de pedir otra.');
        var d = new FormData(f);
        var price = parseFloat(d.get('proposed_price'));
        if (!(price >= 0.5 && price <= 500)) throw new Error('El precio debe estar entre S/ 0.50 y S/ 500.');
        var row = {
          client_id: g.user.id, service_type: d.get('service_type'),
          origin: String(d.get('origin')).trim(), origin_reference: String(d.get('origin_reference') || '').trim() || null,
          destination: String(d.get('destination')).trim(), payment_method: d.get('payment_method'),
          note: String(d.get('note') || '').trim() || null, proposed_price: price
        };
        var r = await sb.from('services').insert(row);
        if (r.error) {
          if (/row-level security/i.test(r.error.message))
            throw new Error('No se pudo enviar: necesitas una suscripción activa y no tener otra solicitud en espera (acéptala o cancélala primero).');
          throw r.error;
        }
        notice('Solicitud enviada. Espera la respuesta de un transportista.');
        f.reset();
        lastSig = '';
        await refresh(true);
      });
    });
  }

  async function transporterPage() {
    var g = await guard(['transporter']);
    if (!g) return;
    var uid = g.user.id;
    adaptNav(g.profile);
    $('#welcome').textContent = 'Hola, ' + g.profile.full_name.split(' ')[0];
    var blocked = statusBlock(g.profile);
    var hasSub = await countdown(uid);
    var box = $('#requests');

    var tp = await sb.from('transporter_profiles').select('*').eq('user_id', uid).maybeSingle();
    var t = tp.data;
    enablePhotoZoom();
    var avatar = null;
    function setAvatar(path) {
      var url = photoUrl(path);
      if (!avatar) {
        $('#welcome').insertAdjacentHTML('beforebegin', '<img class="avatar" id="myAvatar" alt="Tu foto" title="Toca para ver tu foto" style="width:100px;height:100px;object-fit:cover;cursor:zoom-in">');
        avatar = $('#myAvatar');
      }
      avatar.src = url;
      avatar.dataset.zoom = url;
      avatar.dataset.caption = 'Tu foto de perfil';
    }
    if (t && t.photo_path) setAvatar(t.photo_path);
    if (t) {
      var pc = document.createElement('section');
      pc.className = 'card';
      pc.innerHTML = '<h2>' + (t.photo_path ? 'Cambiar foto de perfil' : 'Foto de perfil') + '</h2>' +
        '<p class="muted">' + (t.photo_path ? 'Elige una foto nueva: verás cómo queda antes de guardarla. ' : 'Sube tu foto para que los clientes te reconozcan. ') + 'JPG, PNG o WEBP, máx. 5 MB.</p>' +
        '<form><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
        '<img id="photoPrev" alt="Vista previa" hidden style="width:96px;height:96px;border-radius:50%;object-fit:cover;border:2px solid var(--cyan)">' +
        '<input type="file" accept="image/jpeg,image/png,image/webp" required style="flex:1 1 220px"></div>' +
        '<button class="btn" type="submit">Guardar foto</button></form>';
      $('main').insertBefore(pc, $('main section.card'));
      var pf = $('form', pc), pin = $('input', pf), prev = $('#photoPrev', pc), prevUrl = null;
      function clearPrev() {
        if (prevUrl) { URL.revokeObjectURL(prevUrl); prevUrl = null; }
        prev.hidden = true;
        prev.removeAttribute('src');
      }
      pin.addEventListener('change', function () {
        clearPrev();
        var f = pin.files[0];
        if (!f) return;
        try { checkPhoto(f); } catch (err) { pin.value = ''; notice(friendly(err), true); return; }
        prevUrl = URL.createObjectURL(f);
        prev.src = prevUrl;
        prev.hidden = false;
      });
      pf.addEventListener('submit', function (e) {
        e.preventDefault();
        withBusy(pf, async function () {
          var path = await uploadPhoto(pin.files[0], uid);
          setAvatar(path);
          pin.value = '';
          clearPrev();
          $('h2', pc).textContent = 'Cambiar foto de perfil';
          notice('Foto actualizada correctamente.');
        });
      });
    }

    if (blocked) { notice(blocked, true); box.innerHTML = '<div class="empty">' + esc(blocked) + '</div>'; return; }
    if (!hasSub) notice('Tu suscripción no está activa. Renueva para recibir nuevas solicitudes.', true);

    function availCard(s, mo) {
      var has = mo && mo.status === 'pending';
      return '<div class="service-card"><div class="row"><span class="pill">' + TYPE[s.service_type] + '</span><b>' + money(s.proposed_price) + '</b></div>' +
        '<p><b>' + place(s.origin) + '</b>' + (s.origin_reference ? ' <span class="muted">(' + esc(s.origin_reference) + ')</span>' : '') +
        '<br>→ ' + esc(s.destination) + '</p>' +
        '<p class="muted">Cliente: ' + esc(s.client_name || '—') + ' · Pago: ' + esc(s.payment_method) + '</p>' +
        (s.note ? '<p class="muted">' + esc(s.note) + '</p>' : '') +
        (has ? '<p>Tu oferta: <b>' + money(mo.price) + '</b> · esperando que el cliente elija.</p>' : '') +
        '<div class="actions"><button class="btn small" data-act="accept" data-id="' + s.id + '">Aceptar ' + money(s.proposed_price) + '</button></div>' +
        '<div class="actions"><input type="number" min="0.5" max="500" step="0.5" placeholder="Tu oferta S/" style="max-width:170px" aria-label="Tu oferta">' +
        '<button class="btn secondary small" data-act="offer" data-id="' + s.id + '">' + (has ? 'Actualizar oferta' : 'Enviar oferta') + '</button>' +
        (has ? '<button class="btn ghost small" data-act="withdraw-offer" data-id="' + s.id + '">Retirar oferta</button>' : '') + '</div>' +
        '<small class="muted">' + fdate(s.created_at) + '</small></div>';
    }
    function mineCard(s) {
      var c = contacts.get(s.id), acts = '';
      if (s.status === 'accepted')
        acts = '<button class="btn small" data-act="start" data-id="' + s.id + '">Iniciar servicio</button>' +
          '<button class="btn danger small" data-act="cancel" data-id="' + s.id + '">Cancelar</button>';
      if (s.status === 'in_progress')
        acts = '<button class="btn small" data-act="finish" data-id="' + s.id + '">Finalizar servicio</button>';
      return '<div class="service-card"><div class="row"><span class="pill">' + TYPE[s.service_type] + '</span><span class="pill">' + ST[s.status] + '</span></div>' +
        '<p><b>' + place(s.origin) + '</b>' + (s.origin_reference ? ' <span class="muted">(' + esc(s.origin_reference) + ')</span>' : '') +
        '<br>→ ' + esc(s.destination) + '</p>' +
        '<p>Precio: <b>' + money(s.final_price || s.proposed_price) + '</b> · Pago: ' + esc(s.payment_method) + '</p>' +
        (s.note ? '<p class="muted">' + esc(s.note) + '</p>' : '') +
        (c ? '<div class="details"><small class="muted">Cliente</small>' + contactHtml(c) + '</div>' : '') +
        (acts ? '<div class="actions">' + acts + '</div>' : '') + '</div>';
    }

    var lastSig = '';
    var refresh = poll(async function (force) {
      var r = await sb.from('services').select('*').order('created_at', { ascending: false }).limit(100);
      if (r.error) throw r.error;
      var ro = await sb.from('offers').select('*').eq('transporter_id', uid);
      if (ro.error) throw ro.error;
      var ae = document.activeElement;
      if (!force && ae && ae.tagName === 'INPUT' && box.contains(ae)) return;
      var offerBy = {};
      ro.data.forEach(function (o) { offerBy[o.service_id] = o; });
      var mine = r.data.filter(function (s) { return s.transporter_id === uid; });
      var avail = r.data.filter(function (s) { return s.status === 'requested'; });
      await loadContacts(mine);
      var sig = JSON.stringify(r.data.map(function (s) { return [s.id, s.status, s.transporter_id]; })) +
        JSON.stringify(ro.data.map(function (o) { return [o.service_id, o.price, o.status]; })) + contacts.size;
      if (sig === lastSig && !force) return;
      lastSig = sig;
      box.innerHTML =
        '<h3>Disponibles (' + avail.length + ')</h3>' +
        (avail.length ? avail.map(function (s) { return availCard(s, offerBy[s.id]); }).join('') : '<div class="empty">' +
          (hasSub ? 'No hay solicitudes compatibles por ahora. Se actualiza automáticamente.' :
            'Activa tu suscripción para ver solicitudes. <a href="suscripcion.html?role=transporter">Suscripciones</a>') + '</div>') +
        '<h3 class="section-title">Mis servicios</h3>' +
        (mine.length ? mine.map(mineCard).join('') : '<div class="empty">Aún no has tomado servicios.</div>');
    }, 8000);
    bindActions(box, function () { lastSig = ''; return refresh(true); });
  }

  async function complaintsPage() {
    var g = await guard(null);
    if (!g) return;
    adaptNav(g.profile);
    var f = $('#complaintForm');
    var inp = f.elements['service_id'];
    var sv = await sb.from('services').select('id,service_type,origin,destination,created_at')
      .or('client_id.eq.' + g.user.id + ',transporter_id.eq.' + g.user.id).order('created_at', { ascending: false }).limit(30);
    var sel = document.createElement('select');
    sel.name = 'service_id';
    sel.innerHTML = '<option value="">Ninguno</option>' + ((sv.data || []).map(function (s) {
      return '<option value="' + s.id + '">' + TYPE[s.service_type] + ' · ' + esc(s.origin.slice(0, 30)) + ' → ' + esc(s.destination.slice(0, 30)) + ' · ' + fdate(s.created_at) + '</option>';
    }).join(''));
    if (inp) {
      var lab = inp.closest('label');
      inp.replaceWith(sel);
      if (lab && lab.firstChild) lab.firstChild.textContent = 'Servicio relacionado (opcional)';
    }
    var list = document.createElement('section');
    list.className = 'card';
    list.style.cssText = 'max-width:760px;margin-inline:auto';
    $('main').appendChild(list);
    async function loadList() {
      var r = await sb.from('complaints').select('*').eq('user_id', g.user.id).order('created_at', { ascending: false }).limit(20);
      if (r.error) throw r.error;
      var L = { open: 'Abierto', in_review: 'En revisión', resolved: 'Resuelto' };
      list.innerHTML = '<h2>Mis reclamos</h2>' + (r.data.length ? r.data.map(function (c) {
        return '<div class="service-card"><div class="row"><b>' + esc(c.reason) + '</b><span class="pill">' + L[c.status] + '</span></div><p>' +
          esc(c.description) + '</p><small class="muted">' + fdate(c.created_at) + '</small></div>';
      }).join('') : '<div class="empty">No has enviado reclamos.</div>');
    }
    loadList().catch(function (e) { notice(friendly(e), true); });
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      withBusy(f, async function () {
        var d = new FormData(f);
        var r = await sb.from('complaints').insert({
          user_id: g.user.id, reason: d.get('reason'),
          service_id: d.get('service_id') || null, description: String(d.get('description')).trim()
        });
        if (r.error) throw r.error;
        notice('Reclamo enviado. Administración lo revisará.');
        f.reset();
        await loadList();
      });
    });
  }

  async function adminPage() {
    var g = await guard(['admin']);
    if (!g) return;
    adaptNav(g.profile);
    $('#welcome').textContent = 'Panel de administración';
    enablePhotoZoom();

    var view = {};
    async function load() {
      var res = await Promise.all([
        sb.from('profiles').select('*').order('created_at', { ascending: false }).limit(1000),
        sb.from('transporter_profiles').select('*'),
        sb.from('subscriptions').select('*').order('created_at', { ascending: false }).limit(500),
        sb.from('services').select('*').order('created_at', { ascending: false }).limit(200),
        sb.from('complaints').select('*').order('created_at', { ascending: false }).limit(200),
        sb.from('audit_log').select('*').order('created_at', { ascending: false }).limit(100),
        sb.from('offers').select('service_id,status').limit(2000)
      ]);
      res.forEach(function (r) { if (r.error) throw r.error; });
      var pr = res[0].data, tp = res[1].data, su = res[2].data, sv = res[3].data, co = res[4].data, au = res[5].data, offs = res[6].data;
      var offCount = {};
      offs.forEach(function (o) { if (o.status === 'pending') offCount[o.service_id] = (offCount[o.service_id] || 0) + 1; });
      var U = new Map(pr.map(function (p) { return [p.id, p]; }));
      var T = new Map(tp.map(function (t) { return [t.user_id, t]; }));
      var nm = function (id) { var u = U.get(id); return u ? esc(u.full_name) : '—'; };
      var norm = function (x) { return String(x == null ? '' : x).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); };
      var waLink = function (phone, label) {
        var w = String(phone || '').replace(/\D/g, '');
        if (w.length === 9) w = '51' + w;
        return w ? '<a class="btn ghost small" target="_blank" rel="noopener" href="https://wa.me/' + w + '">' + (label || 'WhatsApp') + '</a>' : '';
      };
      var SL = { pending: 'Pendiente', active: 'Activo', suspended: 'Suspendido', rejected: 'Rechazado' };
      var now = new Date();
      var clients = pr.filter(function (p) { return p.role === 'client'; });
      var trs = pr.filter(function (p) { return p.role === 'transporter'; });

      // suscripción vigente / pendiente por usuario
      var actSub = {}, pendSub = {};
      su.forEach(function (s) {
        if (s.status === 'active' && new Date(s.expires_at) > now) {
          if (!actSub[s.user_id] || new Date(s.expires_at) > new Date(actSub[s.user_id].expires_at)) actSub[s.user_id] = s;
        }
        if (s.status === 'pending') pendSub[s.user_id] = s;
      });
      var planName = function (id) { return id === 'weekly' ? 'Semanal' : 'Mensual'; };
      var monthIncome = su.filter(function (s) {
        return s.status === 'active' && s.reviewed_at && new Date(s.reviewed_at).getMonth() === now.getMonth() && new Date(s.reviewed_at).getFullYear() === now.getFullYear();
      }).reduce(function (a, s) { return a + Number(s.amount || 0); }, 0);

      var stats = [
        [clients.length, 'Clientes'], [trs.length, 'Transportistas'],
        [trs.filter(function (p) { return p.account_status === 'pending'; }).length, 'Transportistas por aprobar'],
        [su.filter(function (s) { return s.status === 'pending'; }).length, 'Pagos pendientes'],
        [Object.keys(actSub).length, 'Suscripciones vigentes'],
        [money(monthIncome), 'Ingresos del mes'],
        [sv.filter(function (s) { return s.status === 'accepted' || s.status === 'in_progress'; }).length, 'Servicios en curso'],
        [sv.length, 'Servicios (total)'], [co.filter(function (c) { return c.status !== 'resolved'; }).length, 'Reclamos abiertos']
      ];
      $('#stats').innerHTML = stats.map(function (s) { return '<div class="stat"><b>' + s[0] + '</b><span>' + s[1] + '</span></div>'; }).join('');

      function userRow(p) {
        var t = T.get(p.id), btns = '', sbtns = '';
        var b = function (label, v, cls) { return '<button class="btn ' + (cls || '') + ' small" data-a="status" data-id="' + p.id + '" data-v="' + v + '">' + label + '</button>'; };
        if (p.account_status !== 'active') btns += b(p.account_status === 'pending' ? 'Aprobar' : 'Activar', 'active');
        if (p.account_status === 'pending') btns += b('Rechazar', 'rejected', 'danger');
        if (p.account_status === 'active') btns += b('Suspender', 'suspended', 'danger');
        btns += '<button class="btn ghost small" data-a="edit" data-id="' + p.id + '" data-name="' + esc(p.full_name) + '" data-phone="' + esc(p.phone) + '">Editar</button>';
        btns += waLink(p.phone);
        var act = actSub[p.id], pend = pendSub[p.id];
        var subTxt = act ? '<span class="ok">Suscripción vigente hasta ' + fdate(act.expires_at) + ' (' + planName(act.plan) + ')</span>'
          : pend ? '<span class="warn">Pago en revisión: ' + planName(pend.plan) + ' · ' + money(pend.amount) + '</span>' : '<span class="muted">Sin suscripción</span>';
        (PLANS[p.role] || []).forEach(function (pl) {
          sbtns += '<button class="btn secondary small" data-a="grant" data-id="' + p.id + '" data-v="' + pl.id + '" data-n="' + esc(p.full_name) +
            '" data-l="' + pl.label + '" data-p="' + pl.price + '">Activar ' + pl.label + ' ' + money(pl.price) + '</button>';
        });
        if (act) {
          sbtns += '<button class="btn ghost small" data-a="adjust" data-id="' + p.id + '">± Días</button>' +
            '<button class="btn danger small" data-a="revoke" data-id="' + p.id + '" data-n="' + esc(p.full_name) + '">Quitar</button>';
        }
        return '<div class="admin-row"><div class="row"><div>' +
          (t && t.photo_path ? '<img class="avatar" alt="Foto de ' + esc(p.full_name) + '" title="Toca para ver la foto" data-zoom="' + esc(photoUrl(t.photo_path)) + '" data-caption="' + esc(p.full_name) + '" src="' + esc(photoUrl(t.photo_path)) + '" style="width:56px;height:56px;cursor:zoom-in"><br>' : '') +
          '<b>' + esc(p.full_name) + '</b><small>' + esc(p.email) + ' · Cel ' + esc(p.phone) + ' · DNI ' + esc(p.dni) + ' · ' + esc(p.age) + ' años · ' + fdate(p.created_at) + '</small>' +
          (t ? '<small>Moto: ' + esc(t.motorcycle) + ' · ' + esc(t.motorcycle_color) + ' · Placa ' + esc(t.plate) + ' · ' + esc((t.service_types || []).join(', ')) + '</small>' : '') +
          '</div><span class="pill">' + (SL[p.account_status] || esc(p.account_status)) + '</span></div>' +
          '<small>' + subTxt + '</small>' +
          '<div class="actions">' + btns + '</div>' +
          (sbtns ? '<div class="actions">' + sbtns + '</div>' : '') + '</div>';
      }
      var empty = '<div class="empty">Sin registros.</div>';
      var rank = function (p) { return p.account_status === 'pending' || pendSub[p.id] ? 0 : 1; };
      clients = clients.slice().sort(function (a, b) { return rank(a) - rank(b); });
      trs = trs.slice().sort(function (a, b) { return rank(a) - rank(b); });
      function renderUsers() {
        var q = norm((($('#adminSearch') || {}).value || '').trim());
        var ok = function (p) {
          if (!q) return true;
          var t = T.get(p.id);
          return norm([p.full_name, p.email, p.phone, p.dni, t && t.plate, t && t.motorcycle].join(' ')).indexOf(q) >= 0;
        };
        var show = function (list, sel, cnt) {
          var l = list.filter(ok);
          $(sel).innerHTML = l.length ? l.map(userRow).join('') : empty;
          var c = $(cnt); if (c) c.textContent = '(' + (q ? l.length + ' de ' : '') + list.length + ')';
        };
        show(clients, '#adminClients', '#cnt-clients');
        show(trs, '#adminTransporters', '#cnt-trs');
      }
      view.renderUsers = renderUsers;
      renderUsers();

      var SS = { pending: 'En revisión', active: 'Activa', rejected: 'Rechazada' };
      var ordered = su.slice().sort(function (a, b) { return (b.status === 'pending') - (a.status === 'pending'); });
      $('#adminSubscriptions').innerHTML = ordered.length ? ordered.map(function (s) {
        var u = U.get(s.user_id);
        return '<div class="admin-row"><div class="row"><div><b>' + nm(s.user_id) + '</b> <small>(' + (u && u.role === 'client' ? 'cliente' : 'transportista') + ')</small>' +
          '<small>Plan solicitado: <b>' + planName(s.plan) + '</b> · ' + money(s.amount) + ' · ' + s.days + ' días</small>' +
          '<small>Solicitada ' + fdate(s.created_at) + (s.status === 'active' ? ' · vence ' + fdate(s.expires_at) : '') + '</small></div>' +
          '<span class="pill">' + (SS[s.status] || esc(s.status)) + '</span></div>' +
          (s.status === 'pending' ? '<div class="actions"><button class="btn small" data-a="sub" data-id="' + s.id + '" data-v="1">Aprobar ' + planName(s.plan) + ' ' + money(s.amount) + '</button>' +
            '<button class="btn danger small" data-a="sub" data-id="' + s.id + '" data-v="0">Rechazar</button>' + waLink(u && u.phone) + '</div>' : '') + '</div>';
      }).join('') : empty;

      var activeTr = trs.filter(function (p) { return p.account_status === 'active'; });
      function renderServices() {
        var fl = ($('#svFilter') || {}).value || '';
        var list = fl ? sv.filter(function (s) { return s.status === fl; }) : sv;
        $('#adminServices').innerHTML = list.length ? list.map(function (s) {
          var acts = '';
          var sb2 = function (label, v, cls) { return '<button class="btn ' + (cls || '') + ' small" data-a="svc" data-id="' + s.id + '" data-v="' + v + '">' + label + '</button>'; };
          if (s.status === 'accepted') acts += sb2('En curso', 'in_progress', 'secondary');
          if (s.status === 'accepted' || s.status === 'in_progress') acts += sb2('Completar', 'completed');
          if (s.status === 'requested' || s.status === 'accepted' || s.status === 'in_progress') acts += sb2('Cancelar', 'cancelled', 'danger');
          var assign = '';
          if (s.status === 'requested' || s.status === 'accepted') {
            var opts = activeTr.filter(function (p) { var t = T.get(p.id); return t && (t.service_types || []).indexOf(s.service_type) >= 0 && p.id !== s.transporter_id; })
              .map(function (p) { return '<option value="' + p.id + '">' + esc(p.full_name) + (actSub[p.id] ? '' : ' (sin suscripción)') + '</option>'; }).join('');
            assign = '<div class="actions"><select data-assign="' + s.id + '"><option value="">' + (s.status === 'accepted' ? 'Reasignar a…' : 'Asignar transportista…') + '</option>' + opts +
              '</select><button class="btn small" data-a="assign" data-id="' + s.id + '">' + (s.status === 'accepted' ? 'Reasignar' : 'Asignar') + '</button></div>';
          }
          return '<div class="admin-row"><div class="row"><div><b>' + TYPE[s.service_type] + '</b> · ' + esc(s.origin) + ' → ' + esc(s.destination) +
            '<small>Cliente: ' + nm(s.client_id) + ' · Transportista: ' + nm(s.transporter_id) + ' · ' + money(s.final_price || s.proposed_price) +
            ' · ' + esc(s.payment_method) + (s.status === 'requested' ? ' · Ofertas: ' + (offCount[s.id] || 0) : '') + ' · ' + fdate(s.created_at) +
            '</small><small>ID: ' + s.id + '</small></div><span class="pill">' + ST[s.status] + '</span></div>' +
            (acts ? '<div class="actions">' + acts + '</div>' : '') + assign + '</div>';
        }).join('') : empty;
      }
      view.renderServices = renderServices;
      renderServices();

      var CL = { open: 'Abierto', in_review: 'En revisión', resolved: 'Resuelto' };
      $('#adminComplaints').innerHTML = co.length ? co.map(function (c) {
        var cu = U.get(c.user_id);
        return '<div class="admin-row"><div class="row"><div><b>' + esc(c.reason) + '</b> · ' + nm(c.user_id) +
          '<small>' + fdate(c.created_at) + (c.service_id ? ' · Servicio ' + c.service_id : '') + '</small></div><span class="pill">' + (CL[c.status] || esc(c.status)) + '</span></div><p>' +
          esc(c.description) + '</p><div class="actions">' +
          (c.status === 'open' ? '<button class="btn ghost small" data-a="comp" data-id="' + c.id + '" data-v="in_review">En revisión</button>' : '') +
          (c.status !== 'resolved' ? '<button class="btn small" data-a="comp" data-id="' + c.id + '" data-v="resolved">Marcar resuelto</button>' : '') +
          waLink(cu && cu.phone) + '</div></div>';
      }).join('') : empty;

      var AL = { account_status: 'Cambio de estado de cuenta', subscription_approved: 'Pago aprobado',
        subscription_rejected: 'Pago rechazado', complaint_status: 'Estado de reclamo',
        subscription_granted: 'Suscripción activada por admin', subscription_adjusted: 'Días de suscripción ajustados',
        subscription_revoked: 'Suscripción retirada', service_status: 'Estado de servicio cambiado',
        service_assigned: 'Servicio asignado', profile_edited: 'Datos de usuario editados' };
      var auEl = $('#adminAudit');
      if (auEl) auEl.innerHTML = au.length ? au.map(function (a) {
        var d = a.detail || {}, tgt = a.target_type === 'user' ? nm(a.target_id) : (d.user_id ? nm(d.user_id) : String(a.target_id || '').slice(0, 8));
        var det = d.days != null ? (d.days > 0 ? '+' : '') + d.days + ' días' :
          d.transporter_id ? 'a ' + nm(d.transporter_id) :
          d.to ? (d.from ? esc(d.from) + ' → ' + esc(d.to) : esc(d.to)) : (d.plan ? esc(d.plan) + (d.amount != null ? ' · ' + money(d.amount) : '') : '');
        return '<div class="admin-row"><div class="row"><div><b>' + (AL[a.action] || esc(a.action)) + '</b><small>' + fdate(a.created_at) +
          ' · Admin: ' + nm(a.admin_id) + ' · Objetivo: ' + tgt + (det ? ' · ' + det : '') + '</small></div></div></div>';
      }).join('') : empty;

      var up = $('#adminUpdated');
      if (up) up.textContent = 'Actualizado ' + new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
    }

    var sInp = $('#adminSearch'), fSel = $('#svFilter'), rBtn = $('#adminRefresh');
    if (sInp) sInp.addEventListener('input', function () { if (view.renderUsers) view.renderUsers(); });
    if (fSel) fSel.addEventListener('change', function () { if (view.renderServices) view.renderServices(); });
    if (rBtn) rBtn.addEventListener('click', async function () {
      rBtn.disabled = true;
      try { await load(); notice('Datos actualizados.'); } catch (err) { notice(friendly(err), true); }
      rBtn.disabled = false;
    });

    $('main').addEventListener('click', async function (e) {
      var b = e.target.closest('button[data-a]');
      if (!b) return;
      var a = b.dataset.a, id = b.dataset.id, v = b.dataset.v, extra;
      if (a === 'status' && (v === 'suspended' || v === 'rejected') && !confirm('¿Confirmas esta acción sobre la cuenta?')) return;
      if (a === 'sub' && v === '0' && !confirm('¿Rechazar este pago?')) return;
      if (a === 'grant' && !confirm('¿Activar el plan ' + b.dataset.l + ' (' + money(Number(b.dataset.p)) + ') a ' + b.dataset.n + '? Se registra como pago recibido y se suma a la suscripción vigente.')) return;
      if (a === 'revoke' && !confirm('¿Quitar la suscripción vigente a ' + b.dataset.n + '?')) return;
      if (a === 'svc' && v === 'cancelled' && !confirm('¿Cancelar este servicio?')) return;
      if (a === 'adjust') {
        var dd = prompt('¿Cuántos días sumar o restar a la suscripción? (ej. 7 o -3)');
        if (dd === null) return;
        extra = parseInt(dd, 10);
        if (!extra) { notice('Escribe un número de días válido.', true); return; }
      }
      if (a === 'edit') {
        var nn = prompt('Nombre completo:', b.dataset.name);
        if (nn === null) return;
        var ph = prompt('Celular:', b.dataset.phone);
        if (ph === null) return;
        extra = { n: nn, p: ph };
      }
      if (a === 'assign') {
        var sel = document.querySelector('select[data-assign="' + id + '"]');
        if (!sel || !sel.value) { notice('Primero elige un transportista.', true); return; }
        if (!confirm('¿Asignar este servicio a ' + sel.options[sel.selectedIndex].text.replace(' (sin suscripción)', '') + '?')) return;
        extra = sel.value;
      }
      b.disabled = true;
      try {
        if (a === 'status') await rpc('admin_set_account_status', { p_user: id, p_status: v });
        else if (a === 'sub') await rpc('admin_review_subscription', { p_id: id, p_approve: v === '1' });
        else if (a === 'comp') await rpc('admin_set_complaint_status', { p_id: id, p_status: v });
        else if (a === 'grant') await rpc('admin_activate_subscription', { p_user: id, p_plan: v });
        else if (a === 'adjust') await rpc('admin_adjust_subscription', { p_user: id, p_days: extra });
        else if (a === 'revoke') await rpc('admin_revoke_subscription', { p_user: id });
        else if (a === 'svc') await rpc('admin_set_service_status', { p_id: id, p_status: v });
        else if (a === 'assign') await rpc('admin_assign_service', { p_id: id, p_transporter: extra });
        else if (a === 'edit') await rpc('admin_update_profile', { p_user: id, p_full_name: extra.n, p_phone: extra.p });
        notice('Cambio guardado.');
        await load();
      } catch (err) { notice(friendly(err), true); b.disabled = false; }
    });

    await load();
  }

  /* ---------- arranque ---------- */
  function start() {
    if (!window.supabase || !C.SUPABASE_URL || !C.SUPABASE_KEY || /PEGA_AQUI/.test(C.SUPABASE_KEY)) {
      notice('Configuración incompleta: falta la clave pública en js/config.js.', true);
      return;
    }
    sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY);
    document.addEventListener('click', async function (e) {
      var b = e.target.closest('[data-logout]');
      if (!b) return;
      e.preventDefault();
      await sb.auth.signOut();
      location.href = 'index.html';
    });
    var routes = {
      home: homePage, login: loginPage,
      'register-client': function () { return regPage('client'); },
      'register-transporter': function () { return regPage('transporter'); },
      subscription: subscriptionPage, client: clientPage, transporter: transporterPage,
      admin: adminPage, complaints: complaintsPage
    };
    Promise.resolve((routes[page] || function () { })()).catch(function (e) { console.error(e); notice(friendly(e), true); });
  }
  start();
})();
