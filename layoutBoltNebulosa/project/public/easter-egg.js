/*
 * Easter egg: premendo insieme i tasti 6 e 7 compare un'esplosione nucleare
 * a schermo intero (lampo, palla di fuoco, onda d'urto, fungo di fumo).
 *
 * Non ha dipendenze: disegna su un <canvas> che si sovrappone alla pagina,
 * non blocca i click e si rimuove da solo alla fine (~9 secondi).
 * Va incluso con un normale <script src="easter-egg.js"></script>.
 */
(function () {
  if (window.__nukeEasterEgg) return;
  window.__nukeEasterEgg = true;

  // ---- impostazioni facili da cambiare ----
  var SOUND = true;          // false = niente rombo audio
  var DURATION = 9;          // secondi totali dell'animazione
  var FADE_OUT = 1.6;        // secondi di dissolvenza finale
  // -----------------------------------------

  var reduceMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var down = {};
  var running = false;

  function isTyping(target) {
    if (!target || !target.tagName) return false;
    var tag = target.tagName.toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
  }

  function keyName(e) {
    if (e.code === "Digit6" || e.code === "Numpad6") return "6";
    if (e.code === "Digit7" || e.code === "Numpad7") return "7";
    if (e.key === "6" || e.key === "7") return e.key;
    return null;
  }

  window.addEventListener("keydown", function (e) {
    if (isTyping(e.target)) return;
    var k = keyName(e);
    if (!k) return;
    down[k] = true;
    if (down["6"] && down["7"] && !running) launch();
  });
  window.addEventListener("keyup", function (e) {
    var k = keyName(e);
    if (k) delete down[k];
  });
  window.addEventListener("blur", function () {
    down = {};
  });

  function rand(a, b) {
    return a + Math.random() * (b - a);
  }

  // ---------- audio: rombo sordo sintetizzato ----------
  function rumble() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = new AC();
      var seconds = 6;
      var buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
      var data = buffer.getChannelData(0);
      for (var i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      var noise = ctx.createBufferSource();
      noise.buffer = buffer;
      var filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.setValueAtTime(1200, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(70, ctx.currentTime + 4.5);

      var sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.setValueAtTime(70, ctx.currentTime);
      sub.frequency.exponentialRampToValueAtTime(28, ctx.currentTime + 5);
      var subGain = ctx.createGain();
      subGain.gain.setValueAtTime(0.0001, ctx.currentTime);
      subGain.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.15);
      subGain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 5.5);

      var gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.7, ctx.currentTime + 0.08);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 5.5);

      var master = ctx.createGain();
      master.gain.value = 0.45; // volume generale, abbassalo se e' troppo forte

      noise.connect(filter);
      filter.connect(gain);
      gain.connect(master);
      sub.connect(subGain);
      subGain.connect(master);
      master.connect(ctx.destination);
      noise.start();
      sub.start();
      setTimeout(function () {
        try { ctx.close(); } catch (err) {}
      }, (seconds + 0.5) * 1000);
    } catch (err) {
      /* l'audio e' opzionale */
    }
  }

  // ---------- colore delle particelle in base all'eta' ----------
  function particleColor(u) {
    var r, g, b;
    if (u < 0.2) {
      var k = u / 0.2; // bianco-giallo -> arancio
      r = 255; g = 245 - 105 * k; b = 200 - 170 * k;
    } else if (u < 0.55) {
      var k2 = (u - 0.2) / 0.35; // arancio -> rosso scuro
      r = 255 - 105 * k2; g = 140 - 100 * k2; b = 30 - 10 * k2;
    } else {
      var k3 = (u - 0.55) / 0.45; // rosso scuro -> fumo grigio-bruno
      r = 150 - 85 * k3; g = 40 + 20 * k3; b = 20 + 40 * k3;
    }
    return [r | 0, g | 0, b | 0];
  }

  function easeOut(x) {
    x = Math.max(0, Math.min(1, x));
    return 1 - Math.pow(1 - x, 3);
  }

  // ---------- l'esplosione ----------
  function launch() {
    running = true;

    var canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText =
      "position:fixed;left:0;top:0;width:100vw;height:100vh;" +
      "z-index:2147483647;pointer-events:none;";
    document.body.appendChild(canvas);
    var ctx = canvas.getContext("2d");

    var W = 0, H = 0, dpr = 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      canvas.width = Math.floor(W * dpr);
      canvas.height = Math.floor(H * dpr);
    }
    resize();
    window.addEventListener("resize", resize);

    if (SOUND) rumble();

    var particles = [];
    var t0 = performance.now();
    var last = t0;
    var burstDone = false;
    var raf = 0;

    function groundY() { return H * 0.86; }
    function capY(t) {
      return groundY() - H * 0.52 * easeOut((t - 0.4) / 3.4);
    }

    function spawn(t, dt) {
      var cx = W / 2;
      var gy = groundY();
      var i, n;

      // esplosione iniziale: palla di fuoco
      if (!burstDone) {
        burstDone = true;
        for (i = 0; i < 170; i++) {
          var a = rand(0, Math.PI * 2);
          var s = rand(60, 520);
          particles.push({
            x: cx + rand(-20, 20), y: gy - rand(0, 30),
            vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.65 - 140,
            r: rand(24, 70), grow: rand(20, 60),
            age: 0, life: rand(2.6, 4.6), drag: 0.32, fire: true
          });
        }
      }

      // gambo del fungo
      if (t > 0.3 && t < 3.3) {
        n = Math.ceil(230 * dt);
        for (i = 0; i < n; i++) {
          particles.push({
            x: cx + rand(-20, 20), y: gy - rand(0, 12),
            vx: rand(-22, 22), vy: -rand(H * 0.16, H * 0.3),
            r: rand(18, 34), grow: rand(8, 18),
            age: 0, life: rand(2.6, 4.2), drag: 0.86, fire: t < 1.2
          });
        }
      }

      // cappello del fungo: nuvola che si allarga mentre sale
      if (t > 0.6 && t < 3.8) {
        n = Math.ceil(320 * dt);
        var cy = capY(t);
        for (i = 0; i < n; i++) {
          var b = rand(-Math.PI * 1.05, 0.05);
          var sp = rand(60, 210);
          particles.push({
            x: cx + rand(-30, 30), y: cy + rand(-10, 25),
            vx: Math.cos(b) * sp, vy: Math.sin(b) * sp * 0.5 - H * 0.04,
            r: rand(28, 62), grow: rand(14, 26),
            age: 0, life: rand(3, 5.2), drag: 0.55, fire: t < 1.6
          });
        }
      }
    }

    function frame(now) {
      var t = Math.max(0, (now - t0) / 1000);
      var dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
      last = now;

      if (t >= DURATION) {
        finish();
        return;
      }

      var cx = W / 2;
      var gy = groundY();

      spawn(t, dt);

      // aggiorna particelle
      var alive = [];
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        p.age += dt;
        if (p.age >= p.life) continue;
        var k = Math.pow(p.drag, dt);
        p.vx *= k;
        p.vy = p.vy * k - 14 * dt; // un po' di spinta verso l'alto (fumo caldo)
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.r += p.grow * dt;
        alive.push(p);
      }
      particles = alive;

      // disegno
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      // leggero tremolio dell'immagine nei primi istanti
      if (!reduceMotion) {
        var shake = Math.max(0, 1 - t / 1.6) * 14;
        ctx.translate(rand(-shake, shake), rand(-shake, shake));
      }

      // cielo che si scurisce e si tinge di rosso
      var dim = Math.min(1, t / 0.6) * (1 - Math.max(0, (t - 4) / 4.5)) * 0.55;
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(25,6,0," + Math.max(0, dim).toFixed(3) + ")";
      ctx.fillRect(-20, -20, W + 40, H + 40);

      // bagliore centrale
      var glow = Math.max(0, 1 - t / 4.5);
      if (glow > 0) {
        var gyc = t > 0.4 ? (gy + capY(t)) / 2 : gy;
        var gr = Math.min(W, H) * (0.35 + 0.35 * easeOut(t / 2));
        var grad = ctx.createRadialGradient(cx, gyc, 0, cx, gyc, gr);
        grad.addColorStop(0, "rgba(255,190,90," + (0.55 * glow).toFixed(3) + ")");
        grad.addColorStop(1, "rgba(255,120,30,0)");
        ctx.globalCompositeOperation = "lighter";
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, H);
      }

      // particelle
      for (var j = 0; j < particles.length; j++) {
        var q = particles[j];
        var u = q.age / q.life;
        var col = particleColor(u);
        var alpha = Math.min(1, u / 0.06) * (u > 0.65 ? 1 - (u - 0.65) / 0.35 : 1);
        alpha *= q.fire ? 0.9 : 0.75;
        if (alpha <= 0.01) continue;
        ctx.globalCompositeOperation = u < 0.3 && q.fire ? "lighter" : "source-over";
        var rg = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.r);
        var c = col[0] + "," + col[1] + "," + col[2];
        rg.addColorStop(0, "rgba(" + c + "," + alpha.toFixed(3) + ")");
        rg.addColorStop(1, "rgba(" + c + ",0)");
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(q.x, q.y, q.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // onda d'urto a terra
      ctx.globalCompositeOperation = "source-over";
      var sw = t / 2.6;
      if (sw < 1) {
        var R = t * H * 1.5;
        ctx.strokeStyle = "rgba(255,225,180," + (0.7 * (1 - sw)).toFixed(3) + ")";
        ctx.lineWidth = 4 * (1 - sw) + 1;
        ctx.beginPath();
        ctx.ellipse(cx, gy, R, R * 0.12, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // orizzonte scuro
      var horizon = ctx.createLinearGradient(0, gy - 6, 0, H);
      horizon.addColorStop(0, "rgba(40,12,0,0.0)");
      horizon.addColorStop(0.08, "rgba(12,4,0,0.85)");
      horizon.addColorStop(1, "rgba(5,2,0,0.95)");
      ctx.fillStyle = horizon;
      ctx.fillRect(-20, gy - 6, W + 40, H - gy + 26);

      // lampo bianco iniziale (piu' morbido se l'utente riduce le animazioni)
      var flash = Math.pow(Math.max(0, 1 - t / (reduceMotion ? 1.6 : 1.1)), 2);
      if (flash > 0) {
        ctx.fillStyle = "rgba(255,255,255," + ((reduceMotion ? 0.3 : 1) * flash).toFixed(3) + ")";
        ctx.fillRect(-20, -20, W + 40, H + 40);
      }

      // dissolvenza finale
      var left = DURATION - t;
      canvas.style.opacity = left < FADE_OUT ? String(Math.max(0, left / FADE_OUT)) : "1";

      raf = requestAnimationFrame(frame);
    }

    function finish() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      running = false;
    }

    raf = requestAnimationFrame(frame);
  }
})();
