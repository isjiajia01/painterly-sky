// painterly-sky — procedural painted-gradient background (WebGL2, zero deps).
// Pipeline (same idea as ardia.dev's hero, re-implemented from scratch):
//   1. scene   : banded sky gradient + sun glow + hills, fbm-wobbled
//   2. flow    : structure tensor of scene -> stroke orientation / coherence
//   3. kuwahara: anisotropic Kuwahara filter along the flow -> oil-paint blobs
//   4. dabs    : jittered-grid brush dabs, height field -> normal -> light + spec
const VS = `#version 300 es
out vec2 vUv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.-1.,0,1);} `;
const COMMON = `#version 300 es
precision highp float;
float hash12(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float vnoise(vec2 x){vec2 c=floor(x),f=fract(x),u=f*f*f*(f*(f*6.-15.)+10.);
 return mix(mix(hash12(c),hash12(c+vec2(1,0)),u.x),mix(hash12(c+vec2(0,1)),hash12(c+1.),u.x),u.y)*2.-1.;}
float fbm(vec2 p,int o){float s=0.,a=.5;for(int i=0;i<o;i++){s+=a*vnoise(p);p=mat2(.8,-.6,.6,.8)*p*2.03+vec2(4.1,1.7);a*=.5;}return s;}
`;
const SCENE = COMMON + `
uniform vec2 uRes; uniform float uTime; uniform vec2 uSun;
uniform vec3 uHorizon,uLow,uMid,uTop,uGlow,uHillFar,uHillNear,uGrass;
in vec2 vUv; out vec4 o;
const float BANDS=7.;
vec3 sky(float h){vec3 c=mix(uHorizon,uLow,smoothstep(0.,.16,h));
 c=mix(c,uMid,smoothstep(.12,.55,h));return mix(c,uTop,smoothstep(.5,1.,h));}
void main(){
 vec2 p=vUv; float asp=uRes.x/uRes.y;
 float h=clamp((p.y-.28)/.72,0.,1.);
 // quantised bands with a wobbling edge = the "stepped" gradient
 float w=fbm(vec2(p.x*asp*.9+uTime*.004,h*2.5+1.7),3)*.045;
 float bp=(h+w)*BANDS, edge=smoothstep(.8,1.,fract(bp));
 float bh=clamp((floor(bp)+edge+.5)/BANDS,0.,1.);
 vec3 col=mix(sky(h),sky(bh),.82);
 // sun glow, also stepped
 vec2 d=(p-uSun)*vec2(asp,1.); float r=length(d);
 float g=exp(-r*3.2)*.55+exp(-r*14.)*1.1+exp(-r*90.)*2.;
 float gs=floor(g*6.)/6.+smoothstep(.75,1.,fract(g*6.))/6.;
 col+=uGlow*mix(g,gs,.7);
 // soft streaky clouds
 float body=fbm(vec2(p.x*asp*.8+uTime*.006,p.y*5.),5), st=fbm(vec2(p.x*asp*.35,p.y*9.)+3.,4);
 float cl=smoothstep(.3,.36,body*.75+st*.55)*smoothstep(.3,.5,p.y)*(1.-smoothstep(.7,.95,p.y));
 col=mix(col,uHorizon*1.12+uGlow*.5,cl*.5);
 // hills (silhouettes), far then near, grass foreground
 float far=.30+.07*fbm(vec2(p.x*asp*1.3+3.,0.),5)+.05*smoothstep(.5,1.,p.x);
 float near=.20+.05*fbm(vec2(p.x*asp*2.2,9.),5);
 col=mix(col,uHillFar,smoothstep(.006,-.006,p.y-far)*.95);
 col=mix(col,uHillNear,smoothstep(.006,-.006,p.y-near));
 float gr=.15+.015*fbm(vec2(p.x*asp*3.,4.),3);
 col=mix(col,uGrass*(.85+.3*fbm(p*vec2(asp,1.)*40.,3)),smoothstep(.004,-.004,p.y-gr));
 o=vec4(col,1.);
}`;
const FLOW = COMMON + `
uniform sampler2D uScene; uniform vec2 uTexel; in vec2 vUv; out vec4 o;
float L(vec2 uv){vec3 c=texture(uScene,uv).rgb;return dot(c,vec3(.299,.587,.114));}
void main(){
 float jxx=0.,jyy=0.,jxy=0.;
 for(int j=-3;j<=3;j++)for(int i=-3;i<=3;i++){
  vec2 uv=vUv+vec2(i,j)*uTexel*2.; float w=exp(-float(i*i+j*j)/8.);
  float gx=L(uv+vec2(uTexel.x,0))-L(uv-vec2(uTexel.x,0));
  float gy=L(uv+vec2(0,uTexel.y))-L(uv-vec2(0,uTexel.y));
  jxx+=w*gx*gx;jyy+=w*gy*gy;jxy+=w*gx*gy;}
 // dominant gradient angle; strokes run perpendicular to it
 float ang=.5*atan(2.*jxy,jxx-jyy)+1.5707963;
 float coh=clamp(sqrt((jxx-jyy)*(jxx-jyy)+4.*jxy*jxy)/(jxx+jyy+1e-5),0.,1.);
 // empty areas (no structure) fall back to a gentle horizontal stroke
 float energy=smoothstep(0.,.02,jxx+jyy);
 coh*=energy; ang=mix(0.,ang,energy);
 o=vec4(vec2(cos(2.*ang),sin(2.*ang))*coh*.5+.5, clamp(.35+energy*.65,0.,1.), 0.5);
}`;
const KUWA = COMMON + `
uniform sampler2D uScene,uFlow; uniform vec2 uTexel; uniform float uRadius; in vec2 vUv; out vec4 o;
void main(){
 vec4 f=texture(uFlow,vUv); vec2 ori=f.xy*2.-1.; float coh=clamp(length(ori),0.,1.);
 float a=.5*atan(ori.y,ori.x); vec2 al=vec2(cos(a),sin(a)),ac=vec2(-al.y,al.x);
 float rad=uRadius*mix(.7,1.6,f.z), st=mix(1.,2.3,coh);
 vec2 A=al*rad*st*uTexel,B=ac*rad/st*uTexel;
 vec3 s[4],q[4]; float ws[4];
 for(int k=0;k<4;k++){s[k]=vec3(0);q[k]=vec3(0);ws[k]=0.;}
 for(int j=-3;j<=3;j++)for(int i=-3;i<=3;i++){
  vec2 u=vec2(i,j)/3.; float d2=dot(u,u); if(d2>1.05)continue;
  vec3 c=texture(uScene,vUv+A*u.x+B*u.y).rgb; float w=exp(-d2*1.6);
  if(u.x>=0.&&u.y>=0.){s[0]+=c*w;q[0]+=c*c*w;ws[0]+=w;}
  if(u.x<=0.&&u.y>=0.){s[1]+=c*w;q[1]+=c*c*w;ws[1]+=w;}
  if(u.x<=0.&&u.y<=0.){s[2]+=c*w;q[2]+=c*c*w;ws[2]+=w;}
  if(u.x>=0.&&u.y<=0.){s[3]+=c*w;q[3]+=c*c*w;ws[3]+=w;}}
 vec3 acc=vec3(0);float ks=0.;
 for(int k=0;k<4;k++){vec3 m=s[k]/ws[k];float v=dot(abs(q[k]/ws[k]-m*m),vec3(1));
  float kk=1./(1.+pow(v*900.,2.));acc+=m*kk;ks+=kk;}
 vec3 c=acc/ks; c=mix(c,floor(c*22.+.5)/22.,.35); // slight posterise
 o=vec4(c,1);
}`;
const DABS = COMMON + `
uniform sampler2D uPaint,uFlow; uniform vec2 uRes,uMouse; uniform float uDpr,uRelief,uTime,uSmear;
uniform vec3 uLight,uSpec; in vec2 vUv; out vec4 o;
vec2 hash22(vec2 p){return vec2(hash12(p),hash12(p+19.19));}
void main(){
 vec2 px=gl_FragCoord.xy;
 // pointer drags paint around (cheap smear)
 vec2 dm=px-uMouse; float m=exp(-dot(dm,dm)/(2.*pow(140.*uDpr,2.)))*uSmear;
 vec2 pt=px-normalize(dm+1e-3)*m*-26.*uDpr*vec2(1,1)*0.; pt=px+dm*m*.18;
 vec3 base=texture(uPaint,pt/uRes).rgb;
 float cs=16.*uDpr, reach=32.3*uDpr; vec2 cell=floor(pt/cs);
 float bo=-1.;vec2 bl=vec2(0),bc=vec2(0);float bs=0.;
 for(int j=-2;j<=2;j++)for(int i=-2;i<=2;i++){
  vec2 id=cell+vec2(i,j),jt=hash22(id),c=(id+jt)*cs,d=pt-c; if(dot(d,d)>reach*reach)continue;
  vec4 f=texture(uFlow,c/uRes); vec2 ori=f.xy*2.-1.;
  float a0=.5*atan(ori.y,ori.x)+(jt.x-.5)*.28; vec2 al=vec2(cos(a0),sin(a0));
  float sz=mix(.4,1.,f.z), hl=mix(11.,27.,sz)*uDpr*(.85+jt.y*.3), hw=mix(3.4,7.5,sz)*uDpr*(.85+jt.x*.3);
  float a=dot(d,al)/hl, b=dot(d,vec2(-al.y,al.x))/(hw*(1.-.35*smoothstep(.1,1.,a)));
  if(pow(abs(a),2.6)+b*b<1.){float ord=hash12(id+7.13);if(ord>bo){bo=ord;bl=vec2(a,b);bc=c;bs=jt.y;}}}
 float h=0.;vec3 col=base;
 if(bo>=0.){
  float ac=abs(bl.y), body=sqrt(max(1.-ac*ac,0.))*(1.-smoothstep(.8,1.,abs(bl.x)));
  float gv=1.-abs(vnoise(vec2(bl.x*.8,bl.y*4.2)+bs*61.));
  float lip=exp(-pow((bl.x-.8)/.12,2.))*(1.-ac*.7), bank=smoothstep(.6,.86,ac)*(1.-smoothstep(.86,1.,ac));
  h=.4*body+.3*gv*gv*body+.34*lip+.2*bank+bo*.16;
  vec3 dab=texture(uPaint,bc/uRes).rgb*(.96+bs*.08);
  col=mix(base,dab,.55)*(1.-.05*bl.x);}
 vec2 wv=sin(px/uDpr*vec2(1.05,1.15)); float gr=wv.x*wv.y*.5+vnoise(px/uDpr*.7)*.5; h+=gr*.012;
 vec3 n=normalize(vec3(-dFdx(h)*uRelief/uDpr,-dFdy(h)*uRelief/uDpr,1.));
 float df=dot(n,uLight)-uLight.z; vec3 hw2=normalize(uLight+vec3(0,0,1));
 float sp=max(pow(max(dot(n,hw2),0.),18.)-pow(hw2.z,18.),0.);
 col=col*(1.+df*.6)*(1.+gr*.03)+uSpec*sp*.16;
 col+=(hash12(px+fract(uTime*3.7)*97.)-.5)/255.; // dither
 o=vec4(col,1);
}`;

export const SUNRISE = {
  horizon:[.99,.86,.62], low:[.96,.74,.66], mid:[.83,.70,.76], top:[.55,.62,.82],
  glow:[1,.82,.35], hillFar:[.20,.42,.36], hillNear:[.45,.52,.26], grass:[.40,.50,.18],
  sun:[.52,.40],
};

export function createPainterlySky(canvas, opts = {}) {
  const P = { ...SUNRISE, ...opts }, dpr = Math.min(devicePixelRatio || 1, 2);
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) throw new Error('WebGL2 required');
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)+'\n'+s.split('\n').slice(14,26).join('\n')); return x; };
  const prog = fs => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); } return { p, u }; };
  const pS = prog(SCENE), pF = prog(FLOW), pK = prog(KUWA), pD = prog(DABS);
  gl.bindVertexArray(gl.createVertexArray());
  let W = 0, H = 0, T = {};
  const mk = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.LINEAR);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return { t, f }; };
  const resize = () => { toneDirty = true; fx?.resize(canvas.clientWidth, canvas.clientHeight); W = canvas.width = Math.round(canvas.clientWidth * dpr);
    H = canvas.height = Math.round(canvas.clientHeight * dpr); T = { scene: mk(), flow: mk(), paint: mk() }; dirty = true; };
  const bind = (u, unit, tex, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(u[name], unit); };
  const pass = (pr, target) => { gl.useProgram(pr.p); gl.bindFramebuffer(gl.FRAMEBUFFER, target?.f ?? null);
    gl.viewport(0, 0, W, H); return pr.u; };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);
  let dirty = true, mouse = [-9999, -9999], smear = 0, raf = 0, t0 = performance.now();
  const introMs = P.sunrise === false ? 0 : 2850, ease = x => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fx = (P.particles !== false && !reduced) ? makeParticles(canvas, dpr) : null;
  const tone = P.toneTargets?.length ? makeTone(P.toneTargets) : null; let toneDirty = true;
  const light = [-.45, .55, .70]; const ln = Math.hypot(...light);
  const render = () => {
    const now = performance.now(), time = (now - t0) / 1000;
    const rise = introMs ? ease((now - t0 - 300) / introMs) : 1, introOn = rise < 1;
    const sunY = P.sun[1] - (1 - rise) * .38; if (introOn) { dirty = true; toneDirty = true; }
    if (dirty) { // static layers only re-render on resize
      let u = pass(pS, T.scene); gl.uniform2f(u.uRes, W, H); gl.uniform1f(u.uTime, 0); gl.uniform2f(u.uSun, P.sun[0], sunY);
      gl.uniform3fv(u.uHorizon, P.horizon); gl.uniform3fv(u.uLow, P.low); gl.uniform3fv(u.uMid, P.mid); gl.uniform3fv(u.uTop, P.top);
      gl.uniform3fv(u.uGlow, P.glow); gl.uniform3fv(u.uHillFar, P.hillFar); gl.uniform3fv(u.uHillNear, P.hillNear); gl.uniform3fv(u.uGrass, P.grass); draw();
      u = pass(pF, T.flow); bind(u, 0, T.scene.t, 'uScene'); gl.uniform2f(u.uTexel, 1 / W, 1 / H); draw();
      u = pass(pK, T.paint); bind(u, 0, T.scene.t, 'uScene'); bind(u, 1, T.flow.t, 'uFlow');
      gl.uniform2f(u.uTexel, 1 / W, 1 / H); gl.uniform1f(u.uRadius, 5 * dpr); draw(); dirty = false;
    }
    const u = pass(pD, null); bind(u, 0, T.paint.t, 'uPaint'); bind(u, 1, T.flow.t, 'uFlow');
    gl.uniform2f(u.uRes, W, H); gl.uniform2f(u.uMouse, mouse[0], mouse[1]); gl.uniform1f(u.uDpr, dpr);
    gl.uniform1f(u.uRelief, 1.3); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uSmear, smear);
    gl.uniform3f(u.uLight, light[0] / ln, light[1] / ln, light[2] / ln); gl.uniform3f(u.uSpec, 1, .95, .8); draw();
    if (tone && toneDirty && !introOn) { tone.update(gl, canvas, W, H, dpr); toneDirty = false; }
    if (fx) fx.step(Math.min(.05, (now - (render.last || now)) / 1000), mouse, smear, dpr, [P.sun[0] * W / dpr, (1 - P.sun[1]) * H / dpr]);
    render.last = now; smear *= .94;
    if (smear > .003 || introOn || (fx && fx.busy)) raf = requestAnimationFrame(render); else raf = 0;
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(render); };
  const onDown = e => { const r = canvas.getBoundingClientRect(); if (fx) { fx.burst(e.clientX - r.left, e.clientY - r.top); kick(); } };
  addEventListener('pointerdown', onDown);
  const onMove = e => { const r = canvas.getBoundingClientRect();
    mouse = [(e.clientX - r.left) * dpr, (r.bottom - e.clientY) * dpr]; smear = 1; kick(); };
  addEventListener('pointermove', onMove);
  const ro = new ResizeObserver(() => { resize(); kick(); }); ro.observe(canvas);
  resize(); smear = 0; render(); if (fx) kick();
  return { destroy() { ro.disconnect(); removeEventListener('pointermove', onMove); removeEventListener('pointerdown', onDown); fx?.destroy(); cancelAnimationFrame(raf); } };
}

// ---- fireflies (always drifting), petals (click burst), sparkles(pointer) on a 2D overlay ----
function makeParticles(host, dpr) {
  const c = document.createElement('canvas'), x = c.getContext('2d');
  Object.assign(c.style, { position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 });
  host.after(c); let w = 1, h = 1, t = 0;
  const flies = [], petals = [], COLORS = [[.95,.66,.72],[.98,.95,.88],[.96,.77,.27],[.73,.64,.86],[.93,.49,.42]];
  const R = Math.random;
  return {
    get busy() { return true; },
    resize(cw, ch) { if (!flies.length) for (let i = 0; i < 34; i++) flies.push({ x: R()*cw, y: ch*(.45+R()*.45), vx: 0, vy: 0, ph: R()*6.28, sp: .6+R()*.8 });
      else for (const f of flies) { f.x *= cw / w; f.y *= ch / h; } w = cw; h = ch; c.width = cw * dpr; c.height = ch * dpr; },
    burst(px, py) { for (const f of flies) { const dx = f.x-px, dy = f.y-py, d = Math.hypot(dx, dy) || 1;
        if (d < 260) { const k = (1-d/260)*520; f.vx += dx/d*k; f.vy += dy/d*k-80; } }
      for (let i = 0; i < 16; i++) { if (petals.length > 90) petals.shift(); const a = -Math.PI/2+(R()-.5)*Math.PI*1.5, v = 180+R()*320;
        petals.push({ x: px, y: py, vx: Math.cos(a)*v, vy: Math.sin(a)*v, age: 0, life: 1.8+R()*1.4, ang: R()*6.28, spin: (R()-.5)*9, size: 9+R()*8, col: COLORS[(R()*5)|0] }); } },
    step(dt, m, smear, d) {
      t += dt; x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h); x.globalCompositeOperation = 'lighter';
      const mx = m[0] / dpr, my = h - m[1] / dpr;
      for (const f of flies) { const o = t*f.sp+f.ph;
        f.vx += (Math.sin(o*1.3)*22+Math.cos(o*.7+f.ph)*14)*dt; f.vy += (Math.cos(o*1.1)*16-9)*dt;
        if (smear > .3) { const dx = f.x-mx, dy = f.y-my, dd = Math.hypot(dx, dy) || 1; if (dd < 120) { f.vx += dx/dd*240*dt; f.vy += dy/dd*240*dt; } }
        const dm = Math.exp(-dt*1.6); f.vx *= dm; f.vy *= dm; f.x += f.vx*dt; f.y += f.vy*dt;
        if (f.y < h*.3) f.y = h*.95; if (f.y > h) f.y = h*.45; if (f.x < -20) f.x = w+20; if (f.x > w+20) f.x = -20;
        const pulse = Math.max(0, Math.sin(t*1.7*f.sp+f.ph*3))**2, a = .25+.75*pulse, r = 22+10*pulse;
        const g = x.createRadialGradient(f.x, f.y, 0, f.x, f.y, r); g.addColorStop(0, `rgba(255,240,120,${.9*a})`); g.addColorStop(1, 'rgba(255,240,120,0)');
        x.fillStyle = g; x.fillRect(f.x-r, f.y-r, r*2, r*2); }
      x.globalCompositeOperation = 'source-over';
      for (let i = petals.length-1; i >= 0; i--) { const p = petals[i]; p.age += dt; if (p.age > p.life) { petals.splice(i, 1); continue; }
        const k = Math.exp(-dt*2.2); p.vx = p.vx*k+Math.sin(p.age*5+p.ang)*60*dt; p.vy = p.vy*k+260*dt; p.x += p.vx*dt; p.y += p.vy*dt; p.ang += p.spin*dt;
        const al = Math.min(1, (p.life-p.age)/.6)*Math.min(1, p.age/.05);
        x.save(); x.translate(p.x, p.y); x.rotate(p.ang); x.fillStyle = `rgba(${p.col.map(v=>v*255|0)},${al})`;
        x.beginPath(); x.ellipse(0, 0, p.size, p.size*.5, 0, 0, 6.2832); x.fill(); x.restore(); }
    },
    destroy() { c.remove(); } };
}

// ---- text tone: sample rendered pixels under each element, flip data-tone light/dark for contrast ----
function makeTone(els) {
  const lin = v => { v /= 255; return v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4; };
  return { update(gl, canvas, W, H, dpr) {
    const cr = canvas.getBoundingClientRect();
    for (const el of els) { const r = el.getBoundingClientRect();
      const x0 = Math.max(0, Math.floor((r.left-cr.left)*dpr)), x1 = Math.min(W, Math.ceil((r.right-cr.left)*dpr));
      const y0 = Math.max(0, Math.floor(H-(r.bottom-cr.top)*dpr)), y1 = Math.min(H, Math.ceil(H-(r.top-cr.top)*dpr));
      const w = x1-x0, h = y1-y0; if (w < 2 || h < 2) continue;
      const buf = new Uint8Array(w*h*4); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(x0, y0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const L = []; for (let i = 0; i < buf.length; i += 16) L.push(.2126*lin(buf[i])+.7152*lin(buf[i+1])+.0722*lin(buf[i+2]));
      L.sort((a, b) => a-b); const dark = L[Math.floor(L.length*.06)], bright = L[Math.floor(L.length*.94)];
      // WCAG contrast of black-ish text vs worst(darkest) bg, white text vs brightest bg
      const cDark = (dark+.05)/.0568, cLight = .85/(bright+.05);
      el.dataset.tone = cDark >= cLight ? 'light' : 'dark'; } } };
}
