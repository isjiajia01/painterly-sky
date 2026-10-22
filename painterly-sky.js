// painterly-sky — procedural painted landscape background (WebGL2, zero deps).
// Pipeline (same architecture as ardia.dev's hero, re-implemented from scratch):
//   bake    : terrain height + material weights baked once into a (x, log z) map
//   scene   : sky (banded gradient, sun/moon, clouds, stars) + heightfield raymarch
//             with soft sun shadows and aerial haze; alpha = region id
//   flow    : structure tensor of the scene -> stroke orientation / coherence
//   kuwahara: anisotropic Kuwahara filter along the flow -> oil-paint blobs
//   dabs    : jittered brush dabs lit as a height field, pointer-smear texture
const VS = `#version 300 es
out vec2 vUv; void main(){ vec2 p=vec2((gl_VertexID<<1)&2, gl_VertexID&2); vUv=p; gl_Position=vec4(p*2.-1.,0,1);} `;
const COMMON = `#version 300 es
precision highp float; precision highp int;
const float PI=3.14159265;
float hash12(vec2 p){vec3 q=fract(vec3(p.xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float vnoise(vec2 x){vec2 c=floor(x),f=fract(x),u=f*f*f*(f*(f*6.-15.)+10.);
 return mix(mix(hash12(c),hash12(c+vec2(1,0)),u.x),mix(hash12(c+vec2(0,1)),hash12(c+1.),u.x),u.y)*2.-1.;}
const mat2 TURN=mat2(.8,-.6,.6,.8);
float fbm(vec2 p,int o){float s=0.,a=.5;for(int i=0;i<o;i++){s+=a*vnoise(p);p=TURN*p*2.03+vec2(4.1,1.7);a*=.5;}return s;}
// terrain domain: u across (width grows with depth), v = log(depth)
const float TZN=1.,TZF=16000.,TW0=6.,TSLOPE=1.05,HMIN=-60.,HRANGE=2300.;
vec2 terrainWorld(vec2 uv){float z=TZN*pow(TZF/TZN,uv.y);return vec2((uv.x*2.-1.)*(TW0+z*TSLOPE),z);}
vec2 terrainUv(vec2 p){float z=max(p.y,TZN);return vec2(p.x/(TW0+z*TSLOPE)*.5+.5,log(z/TZN)/log(TZF/TZN));}
`;
const BAKE = COMMON + `
uniform vec2 uBake; layout(location=0) out vec4 oH; layout(location=1) out vec4 oM;
vec3 noised(vec2 x){vec2 c=floor(x),f=fract(x),u=f*f*f*(f*(f*6.-15.)+10.),du=30.*f*f*(f*(f-2.)+1.);
 float a=hash12(c),b=hash12(c+vec2(1,0)),cc=hash12(c+vec2(0,1)),d=hash12(c+1.);
 float k1=b-a,k2=cc-a,k4=a-b-cc+d;
 return vec3(-1.+2.*(a+k1*u.x+k2*u.y+k4*u.x*u.y),2.*du*vec2(k1+k4*u.y,k2+k4*u.x));}
float erodedFbm(vec2 p,int o){float s=0.,a=.5;vec2 sl=vec2(0);for(int i=0;i<o;i++){vec3 n=noised(p);sl+=n.yz;s+=a*n.x/(1.+dot(sl,sl));a*=.5;p=TURN*p*2.;}return s;}
float ridged(vec2 p,int o){float s=0.,a=.5,w=1.;for(int i=0;i<o;i++){float n=1.-abs(vnoise(p));n*=n;s+=n*a*w;w=clamp(n*1.8,0.,1.);a*=.5;p=TURN*p*2.07+vec2(1.7,9.2);}return s;}
float smax(float a,float b,float k){float h=max(k-abs(a-b),0.)/k;return max(a,b)+h*h*k*.25;}
float dome(vec2 p,vec2 c,vec2 r,float h){float q=length((p-c)/r);return h*pow(.5+.5*cos(PI*min(q,1.)),1.15);}
float meadowH(vec2 p){float near=.16*vnoise(p*.09)+.07*vnoise(p*.33+7.);float far=smoothstep(30.,360.,p.y);
 return near+far*(6.+8.*vnoise(p*.004+3.)+2.5*vnoise(p*.018+1.3));}
float terrain(vec2 p,out vec3 w){
 float meadow=meadowH(p);
 float dark=-1e4; float crest=900.+190.*vnoise(vec2(p.x/950.,4.2)); float dz=p.y-crest;
 float prof=exp(-pow(dz/(dz<0.?360.:640.),2.));
 if(prof>.002){float rise=smoothstep(-60.,820.,p.x);
  float det=erodedFbm(p/300.+vec2(5.3,1.1),7);
  float canopy=.55+.45*vnoise(p/10.)+.3*vnoise(p/4.1);
  dark=(190.*rise+24.*smoothstep(-240.,60.,p.x))*prof+38.*det*prof*mix(.4,1.,rise)+9.*canopy*smoothstep(.04,.3,prof)-4.-40.*(1.-prof);}
 float sage=-1e4; float body=max(dome(p,vec2(-1700.,3800.),vec2(2150.,1500.),880.),dome(p,vec2(-120.,4550.),vec2(1950.,1300.),470.));
 if(body>.5) sage=body+105.*erodedFbm(p/760.+vec2(2.,7.),8)*smoothstep(0.,140.,body)-12.;
 float far=-1e4; float fm=smoothstep(6200.,8800.,p.y)*(1.-smoothstep(14600.,15900.,p.y));
 if(fm>.001) far=fm*(1380.*ridged(p/3900.+vec2(3.3,8.1),9)+190.*erodedFbm(p/1300.,6)-140.);
 float h=smax(meadow,dark,30.); h=smax(h,sage,140.); h=smax(h,far,260.);
 w=vec3(smoothstep(-16.,16.,dark-max(meadow,max(sage,far))),smoothstep(-60.,60.,sage-max(meadow,max(dark,far))),smoothstep(-110.,110.,far-max(meadow,max(dark,sage))));
 return h;}
void main(){vec2 p=terrainWorld(gl_FragCoord.xy/uBake); vec3 w; float h=terrain(p,w);
 float pk=floor(clamp((h-HMIN)/HRANGE,0.,1.)*65535.),hi=floor(pk/256.);
 oH=vec4(hi/255.,(pk-hi*256.)/255.,0,1); oM=vec4(w,1);}`;
const SCENE = COMMON + `
uniform vec2 uRes; uniform float uTime,uAspect,uTanHalf,uPitch,uNight,uAmbient,uHaze;
uniform sampler2D uH,uM; uniform vec2 uBake;
uniform vec3 uHorizon,uLow,uMid,uTop,uGlow,uKey,uSunDir,uMoonDir;
in vec2 vUv; out vec4 o;
const float BANDS=7.,CAMH=1.7;
float dec(vec4 t){return (t.r*65280.+t.g*255.)/65535.*HRANGE+HMIN;}
float hAt(vec2 p){vec2 uv=clamp(terrainUv(p),0.,1.);vec2 st=uv*uBake-.5;ivec2 b=ivec2(floor(st)),mx=ivec2(uBake)-1;vec2 f=fract(st);
 float a=dec(texelFetch(uH,clamp(b,ivec2(0),mx),0)),bb=dec(texelFetch(uH,clamp(b+ivec2(1,0),ivec2(0),mx),0));
 float c=dec(texelFetch(uH,clamp(b+ivec2(0,1),ivec2(0),mx),0)),d=dec(texelFetch(uH,clamp(b+ivec2(1,1),ivec2(0),mx),0));
 return mix(mix(a,bb,f.x),mix(c,d,f.x),f.y);}
vec3 skyGrad(float h){vec3 c=mix(uHorizon,uLow,smoothstep(0.,.16,h));c=mix(c,uMid,smoothstep(.12,.55,h));return mix(c,uTop,smoothstep(.5,1.,h));}
float sunGlow(vec3 d){float mu=max(dot(d,uSunDir),0.);float nh=exp(-max(d.y,0.)*9.);
 return pow(mu,4.)*(.4+.6*nh)+pow(mu,28.)*1.4+pow(mu,380.)*2.+nh*(.3+.7*mu)*.45;}
float shadowAt(vec3 P,vec3 L){if(L.y<-.02)return 0.;float s=1.,t=2.+hash12(P.xz*7.)*1.5;
 for(int i=0;i<22;i++){vec3 q=P+L*t;s=min(s,8.*(q.y-hAt(q.xz))/t);t*=1.4;}return smoothstep(0.,.6,s);}
vec3 lin(vec3 c){return pow(c,vec3(2.2));}
void main(){
 vec2 nd=vUv*2.-1.;
 vec3 fw=vec3(0,sin(uPitch),cos(uPitch)),up=vec3(0,cos(uPitch),-sin(uPitch));
 vec3 rd=normalize(fw+nd.x*uTanHalf*uAspect*vec3(1,0,0)+nd.y*uTanHalf*up);
 vec3 col; float region=.1;
 float h=clamp(max(rd.y,0.)/.6,0.,1.), mu=max(dot(rd,uSunDir),0.);
 vec2 plane=rd.xz/(rd.y+.07);
 // ---- sky
 float wob=fbm(vec2(plane.x*.35+uTime*.004,h*2.5+1.7),3)*.045,bp=(h+wob)*BANDS,be=smoothstep(.8,1.,fract(bp));
 float bh=clamp((floor(bp)+be+.5)/BANDS,0.,1.);
 float g=sunGlow(rd), gs=floor(g*6.)/6.+smoothstep(.75,1.,fract(g*6.))/6.;
 vec3 sky=mix(skyGrad(h),skyGrad(bh),.82)+uGlow*mix(g,gs,.7)*.55;
 if(rd.y>0.){
  vec2 dr=vec2(uTime*.006,uTime*.0015);
  float body=fbm(plane*vec2(.5,1.5)+dr+vec2(3.1,.4),5),st=fbm(plane*vec2(.22,2.6)+dr*.7+vec2(-1.3,5.),4);
  float cov=smoothstep(.3,.36,body*.75+st*.55)*smoothstep(.04,.2,h)*(1.-smoothstep(.5,.9,h));
  vec3 lit=uHorizon*1.12+uGlow*.6+vec3(.25,.2,.1)*pow(mu,6.);
  sky=mix(sky,lit,cov*.6);
  // stars
  vec2 sp=vec2(atan(rd.x,rd.z),rd.y)*vec2(90.,90.)*1.4; vec2 sc=floor(sp);
  float star=step(.992,hash12(sc))*smoothstep(.45,.0,length(fract(sp)-.5))*(.6+.4*sin(uTime*2.+hash12(sc+3.)*30.));
  sky+=vec3(.9,.92,1.)*star*smoothstep(.45,.9,uNight)*smoothstep(0.,.12,rd.y)*(1.-cov);
 }
 // sun disc + moon
 float ang=acos(clamp(dot(rd,uSunDir),-1.,1.)); float disc=1.-smoothstep(.040,.046,ang+fbm(rd.xy*60.,2)*.003);
 sky=mix(sky,vec3(1.,.78,.22),disc*step(0.,uSunDir.y+.04)*(1.-uNight));
 float ma=acos(clamp(dot(rd,uMoonDir),-1.,1.));
 sky+=vec3(.55,.62,.8)*(exp(-max(ma-.034,0.)*28.)*.35+(1.-smoothstep(.030,.036,ma))*.8)*uNight;
 col=sky;
 // ---- terrain raymarch
 if(rd.y<.3){
  vec3 ro=vec3(0,CAMH,0); float t=1.,tp=1.; bool hit=false;
  for(int i=0;i<230;i++){vec3 p=ro+rd*t;float d=p.y-hAt(p.xz);
   if(d<0.){hit=true;break;} tp=t; t+=max(d*.5,t*.05+.05); if(t>TZF*1.1)break;}
  if(hit){
   for(int i=0;i<6;i++){float m=.5*(t+tp);vec3 p=ro+rd*m;if(p.y<hAt(p.xz))t=m;else tp=m;}
   vec3 P=ro+rd*t; float e=max(.06,t*.004);
   vec3 n=normalize(vec3(hAt(P.xz-vec2(e,0))-hAt(P.xz+vec2(e,0)),2.*e,hAt(P.xz-vec2(0,e))-hAt(P.xz+vec2(0,e))));
   vec3 w=texture(uM,clamp(terrainUv(P.xz),0.,1.)).rgb;
   float nz=fbm(P.xz*.7,3), nz2=fbm(P.xz*.04,3);
   vec3 meadow=mix(vec3(.36,.44,.15),vec3(.66,.66,.28),.5+.5*nz2)*(.85+.35*nz);
   vec3 alb=meadow; alb=mix(alb,vec3(.07,.24,.20)*(.8+.4*nz),w.x); alb=mix(alb,vec3(.62,.62,.42)*(.85+.3*nz2),w.y); alb=mix(alb,vec3(.40,.50,.60),w.z);
   alb=lin(alb);
   vec3 Ld=normalize(mix(uSunDir,uMoonDir,smoothstep(.4,.7,uNight)));
   float sh=shadowAt(P+n*.3,Ld);
   float lam=max(dot(n,Ld),0.)*.9+.1;
   vec3 amb=lin(uMid)*.9+lin(uHorizon)*.35*(1.-n.y*.5);
   vec3 lit=alb*(amb*.8*uAmbient*mix(1.,.7,uNight)+uKey*.5*lam*sh);
   lit+=lin(uHorizon)*.08*pow(1.-n.y,3.)*0.;
   vec3 c=pow(lit/(1.+lit*.25),vec3(1./2.2));
   float fog=1.-exp(-t*uHaze); c=mix(c,mix(uHorizon,uLow,.2)*(1.-uNight*.4)+uGlow*.15*sunGlow(rd),fog);
   col=c; region=(w.x+w.y+w.z>.5||t>140.)?.5:.9;
  }
 }
 o=vec4(col,region);
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
 float ang=.5*atan(2.*jxy,jxx-jyy)+1.5707963;
 float coh=clamp(sqrt((jxx-jyy)*(jxx-jyy)+4.*jxy*jxy)/(jxx+jyy+1e-5),0.,1.);
 float energy=smoothstep(0.,.02,jxx+jyy);
 coh*=energy; ang=mix(0.,ang,energy);
 float region=texture(uScene,vUv).a;
 float meadow=step(.75,region);   // near meadow: strokes lean upright like grass
 ang=mix(ang,1.5707963+(vnoise(vUv*vec2(60.,20.))*.35),meadow*.85); coh=max(coh,meadow*.55);
 o=vec4(vec2(cos(2.*ang),sin(2.*ang))*coh*.5+.5, mix(clamp(.35+energy*.65,0.,1.),.95,meadow), region);
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
 vec3 c=acc/ks; float lv=mix(26.,18.,step(f.a,.25)); c=mix(c,floor(c*lv+.5)/lv,.35);
 o=vec4(c,1);
}`;
const DABS = COMMON + `
uniform sampler2D uPaint,uFlow,uSmear; uniform vec2 uRes,uSunPx,uMoonPx; uniform float uDpr,uRelief,uTime,uSunR,uNight,uSunVis;
uniform vec3 uLight,uSpec,uGlowCol; in vec2 vUv; out vec4 o;
vec2 hash22(vec2 p){return vec2(hash12(p),hash12(p+19.19));}
void main(){
 vec2 px=gl_FragCoord.xy;
 vec2 sm=texture(uSmear,px/uRes).xy; float reg0=texture(uFlow,px/uRes).a;
 vec2 pt=px-sm*uRes*mix(.35,1.,reg0);                 // pointer drags the paint
 vec3 base=texture(uPaint,pt/uRes).rgb;
 float cs=16.*uDpr, reach=32.3*uDpr; vec2 cell=floor(pt/cs);
 float bo=-1.;vec2 bl=vec2(0),bc=vec2(0);float bs=0.,br=0.;
 for(int j=-2;j<=2;j++)for(int i=-2;i<=2;i++){
  vec2 id=cell+vec2(i,j),jt=hash22(id),c=(id+jt)*cs,d=pt-c; if(dot(d,d)>reach*reach)continue;
  vec4 f=texture(uFlow,c/uRes); vec2 ori=f.xy*2.-1.;
  float a0=.5*atan(ori.y,ori.x)+(jt.x-.5)*.28; vec2 al=vec2(cos(a0),sin(a0));
  float sz=mix(.4,1.,f.z), hl=mix(11.,27.,sz)*uDpr*(.85+jt.y*.3), hw=mix(3.4,7.5,sz)*uDpr*(.85+jt.x*.3);
  float a=dot(d,al)/hl, b=dot(d,vec2(-al.y,al.x))/(hw*(1.-.35*smoothstep(.1,1.,a)));
  if(pow(abs(a),2.6)+b*b<1.){float ord=hash12(id+7.13);if(ord>bo){bo=ord;bl=vec2(a,b);bc=c;bs=jt.y;br=f.a;}}}
 float h=0.;vec3 col=base;
 if(bo>=0.){
  float ac=abs(bl.y), body=sqrt(max(1.-ac*ac,0.))*(1.-smoothstep(.8,1.,abs(bl.x)));
  float gv=1.-abs(vnoise(vec2(bl.x*.8,bl.y*4.2)+bs*61.));
  float lip=exp(-pow((bl.x-.8)/.12,2.))*(1.-ac*.7), bank=smoothstep(.6,.86,ac)*(1.-smoothstep(.86,1.,ac));
  float gain=br<.25?.78:br<.75?1.:.7;
  h=(.4*body+.3*gv*gv*body+.34*lip+.2*bank+bo*.16)*gain;
  vec3 dab=texture(uPaint,bc/uRes).rgb*(.96+bs*.08);
  col=mix(base,dab,.55)*(1.-.05*bl.x);}
 vec2 wv=sin(px/uDpr*vec2(1.05,1.15)); float gr=wv.x*wv.y*.5+vnoise(px/uDpr*.7)*.5; h+=gr*.012;
 vec3 n=normalize(vec3(-dFdx(h)*uRelief/uDpr,-dFdy(h)*uRelief/uDpr,1.));
 float df=dot(n,uLight)-uLight.z; vec3 hw2=normalize(uLight+vec3(0,0,1));
 float sp=max(pow(max(dot(n,hw2),0.),18.)-pow(hw2.z,18.),0.);
 col=col*(1.+df*.6)*(1.+gr*.03)+uSpec*sp*mix(.1,.22,br);
 float sd=length(px-uSunPx);
 float gl=exp(-max(sd-uSunR,0.)/(uSunR*.8))*.4+exp(-sd/(uSunR*5.))*.14;
 col+=pow(uGlowCol*1.4+vec3(.035,.018,0.),vec3(1./2.2))*gl*.5*uSunVis*(1.-uNight);
 float md=length(px-uMoonPx); col+=vec3(.55,.62,.8)*exp(-max(md-uSunR*.8,0.)/(uSunR*1.4))*.3*uNight;
 col+=(hash12(px+fract(uTime*3.7)*97.)-.5)/255.;
 o=vec4(col,1);
}`;

// ---- time of day: colour keyframes (display-space hex), phase 0..1 = night→dawn→noon→dusk→night
const hex = s => { const v = parseInt(s.slice(1), 16); return [v >> 16 & 255, v >> 8 & 255, v & 255].map(x => x / 255); };
const NIGHT = { horizon: '#2c416c', low: '#25375f', mid: '#1b2a50', top: '#111b38', glow: '#3b4f86', gs: 0, key: [.34, .5, .72], amb: .62, haze: 14e-5, night: 1 };
const KEYS = [{ p: 0, ...NIGHT },
  { p: .06, horizon: '#e6998b', low: '#c98190', mid: '#9a83a8', top: '#7c85ab', glow: '#ff8a5c', gs: .42, key: [.95, .42, .26], amb: .82, haze: 19e-5, night: 0 },
  { p: .14, horizon: '#f4b08a', low: '#e3a8a0', mid: '#b8a7bd', top: '#919abb', glow: '#ffa064', gs: .45, key: [1.35, .78, .46], amb: .9, haze: 16e-5, night: 0 },
  { p: .3, horizon: '#f7e5c2', low: '#f3e8d4', mid: '#e1e4dc', top: '#bccfd9', glow: '#ffcf7c', gs: .26, key: [2.05, 1.62, 1.08], amb: 1, haze: 11e-5, night: 0 },
  { p: .58, horizon: '#f4ead6', low: '#ebe8dc', mid: '#d6e0e0', top: '#aec7d7', glow: '#ffe0a0', gs: .2, key: [2.25, 1.92, 1.42], amb: 1.05, haze: 1e-4, night: 0 },
  { p: .84, horizon: '#f8c47c', low: '#f2cd9c', mid: '#e2bfa4', top: '#b9b0b6', glow: '#ffb35a', gs: .5, key: [2.15, 1.3, .58], amb: .95, haze: 16e-5, night: 0 },
  { p: .92, horizon: '#ef9070', low: '#c96f76', mid: '#b36871', top: '#5d5281', glow: '#ff7a4f', gs: .55, key: [1.05, .44, .3], amb: .74, haze: 18e-5, night: .15 },
  { p: 1, ...NIGHT }].map(k => ({ ...k, c: ['horizon', 'low', 'mid', 'top', 'glow'].map(n => hex(k[n])) }));
const sm3 = x => x * x * (3 - 2 * x), mix = (a, b, t) => a + (b - a) * t, mixv = (a, b, t) => a.map((v, i) => mix(v, b[i], t));
const rad = d => d * Math.PI / 180;
export function dayState(r) {
  r = Math.min(1, Math.max(0, r)); let i = 0; while (i < KEYS.length - 2 && KEYS[i + 1].p <= r) i++;
  const a = KEYS[i], b = KEYS[i + 1], t = sm3((r - a.p) / (b.p - a.p));
  const [horizon, low, mid, top, glow] = a.c.map((c, k) => mixv(c, b.c[k], t));
  const gs = mix(a.gs, b.gs, t), night = mix(a.night, b.night, t);
  const az = rad(mix(16.2, -4.6, r)), el = Math.min(rad(26.5), rad(-6) + rad(26.5) * Math.sin(Math.PI * r) ** .8);
  const dir = (az, el) => [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
  return { horizon, low, mid, top, glow: glow.map(v => v * gs), key: mixv(a.key, b.key, t).map(v => v * 1), amb: mix(a.amb, b.amb, t),
    haze: mix(a.haze, b.haze, t), night, sunDir: dir(az, el), sunEl: el, moonDir: dir(rad(24), rad(-12 + 40 * night)) };
}

// ---- pointer smear: spring-less decay grid; pointer motion deposits displacement (64x40, RG)
class Smear {
  constructor(c = 64, r = 40) { this.c = c; this.r = r; this.field = new Float32Array(c * r * 2); this.last = { x: 0, y: 0, set: false }; this.idle = 0; }
  get settled() { return this.idle > 4; }
  step(dt, ptr, W, H, radius) {
    const { c, r, field: f } = this, k = Math.exp(-dt / .45); let mx = 0;
    for (let i = 0; i < f.length; i++) { f[i] *= k; mx = Math.max(mx, Math.abs(f[i])); }
    const L = this.last; this.idle = mx < 3e-4 ? this.idle + 1 : 0;
    if (!ptr.active || dt <= 0) { L.set = false; return; }
    const was = L.set, dx = (ptr.x - L.x) / W, dy = -(ptr.y - L.y) / H; L.x = ptr.x; L.y = ptr.y; L.set = true;
    if (!was || Math.abs(dx) + Math.abs(dy) < 1e-5) return; this.idle = 0;
    const u = ptr.x / W, v = 1 - ptr.y / H, cl = x => Math.max(-.045, Math.min(.045, x));
    for (let j = 0; j < r; j++) { const oy = ((j + .5) / r - v) * H; if (Math.abs(oy) > radius) continue;
      for (let i = 0; i < c; i++) { const ox = ((i + .5) / c - u) * W, d = Math.hypot(ox, oy); if (d > radius) continue;
        const l = 1 - d / radius, w = l * l * (3 - 2 * l), n = (j * c + i) * 2; f[n] = cl(f[n] + dx * w * .6); f[n + 1] = cl(f[n + 1] + dy * w * .6); } }
  }
}

export const SUNRISE = { timeOfDay: .2 };

export function createPainterlySky(canvas, opts = {}) {
  const P = { ...SUNRISE, ...opts };
  const gl = canvas.getContext('webgl2', { antialias: false });
  if (!gl) throw new Error('WebGL2 required');
  const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x);
    if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = fs => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i < n; i++) {
      const nm = gl.getActiveUniform(p, i).name; u[nm] = gl.getUniformLocation(p, nm); } return { p, u }; };
  const pB = prog(BAKE), pS = prog(SCENE), pF = prog(FLOW), pK = prog(KUWA), pD = prog(DABS);
  gl.bindVertexArray(gl.createVertexArray());
  const tex = (w, h, ifmt, fmt, type, filter) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
    for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, filter);
    for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE); return t; };
  const fbo = (...ts) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    ts.forEach((t, i) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(ts.map((_, i) => gl.COLOR_ATTACHMENT0 + i)); return f; };
  const bind = (u, unit, t, name) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(u[name], unit); };
  const draw = () => gl.drawArrays(gl.TRIANGLES, 0, 3);

  // terrain bake (once)
  const BW = 512, BH = 1024;
  const hTex = tex(BW, BH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST), mTex = tex(BW, BH, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR);
  { const f = fbo(hTex, mTex); gl.useProgram(pB.p); gl.viewport(0, 0, BW, BH); gl.uniform2f(pB.u.uBake, BW, BH); draw(); gl.deleteFramebuffer(f); }

  // pointer-smear texture
  const smear = new Smear(); const smTex = tex(smear.c, smear.r, gl.RG16F, gl.RG, gl.HALF_FLOAT, gl.LINEAR);

  let W = 0, H = 0, dpr = 1, T = {}, dirty = true, mouse = { x: -9999, y: -9999, active: false }, raf = 0, last = 0;
  const t0 = performance.now(), introMs = P.sunrise === false ? 0 : 2850;
  const ease = x => (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, x)))) / 2;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fx = (P.particles !== false && !reduced) ? makeParticles(canvas, Math.min(devicePixelRatio || 1, 2)) : null;
  const tone = P.toneTargets?.length ? makeTone(P.toneTargets) : null; let toneDirty = true;
  const mkT = () => { const t = tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR); return { t, f: fbo(t) }; };
  const resize = () => {
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    dpr = Math.min(devicePixelRatio || 1, 1.6, Math.sqrt((P.pixelBudget || 2.4e6) / Math.max(1, cw * ch)));
    W = canvas.width = Math.max(2, Math.round(cw * dpr)); H = canvas.height = Math.max(2, Math.round(ch * dpr));
    for (const k in T) { gl.deleteTexture(T[k].t); gl.deleteFramebuffer(T[k].f); }
    T = { scene: mkT(), flow: mkT(), paint: mkT() }; fx?.resize(cw, ch); dirty = true; toneDirty = true; };

  const phaseAt = now => {
    const target = P.timeOfDay, e = introMs ? ease((now - t0 - 300) / introMs) : 1;
    let r = target * e; if (P.cycle) r = (target + Math.max(0, now - t0 - introMs) / 1000 / P.cycle) % 1; return { r, busy: e < 1 || !!P.cycle }; };
  const fov = rad(62), tanHalf = Math.tan(fov / 2), pitch = Math.atan(.4 * tanHalf);
  const project = d => { // direction -> css px (origin top-left) in canvas space
    const fw = [0, Math.sin(pitch), Math.cos(pitch)], up = [0, Math.cos(pitch), -Math.sin(pitch)];
    const z = d[0] * 0 + d[1] * fw[1] + d[2] * fw[2], x = d[0], y = d[1] * up[1] + d[2] * up[2];
    if (z <= .01) return [-9999, -9999]; return [(x / z / (tanHalf * W / H) * .5 + .5) * W, (1 - (y / z / tanHalf * .5 + .5)) * H]; };

  const render = () => {
    raf = 0; const now = performance.now(), time = (now - t0) / 1000, dt = Math.min(.05, (now - (last || now)) / 1000); last = now;
    const { r, busy } = phaseAt(now), S = dayState(r);
    if (busy) { dirty = true; toneDirty = true; }
    const sunPx = project(S.sunDir), moonPx = project(S.moonDir);
    if (dirty) {
      let u = (gl.useProgram(pS.p), gl.bindFramebuffer(gl.FRAMEBUFFER, T.scene.f), gl.viewport(0, 0, W, H), pS.u);
      gl.uniform2f(u.uRes, W, H); gl.uniform1f(u.uTime, time); gl.uniform1f(u.uAspect, W / H); gl.uniform1f(u.uTanHalf, tanHalf); gl.uniform1f(u.uPitch, pitch);
      gl.uniform1f(u.uNight, S.night); gl.uniform1f(u.uAmbient, S.amb); gl.uniform1f(u.uHaze, S.haze); gl.uniform2f(u.uBake, BW, BH);
      gl.uniform3fv(u.uHorizon, S.horizon); gl.uniform3fv(u.uLow, S.low); gl.uniform3fv(u.uMid, S.mid); gl.uniform3fv(u.uTop, S.top);
      gl.uniform3fv(u.uGlow, S.glow); gl.uniform3fv(u.uKey, S.key); gl.uniform3fv(u.uSunDir, S.sunDir); gl.uniform3fv(u.uMoonDir, S.moonDir);
      bind(u, 0, hTex, 'uH'); bind(u, 1, mTex, 'uM'); draw();
      gl.useProgram(pF.p); gl.bindFramebuffer(gl.FRAMEBUFFER, T.flow.f); u = pF.u; bind(u, 0, T.scene.t, 'uScene'); gl.uniform2f(u.uTexel, 1 / W, 1 / H); draw();
      gl.useProgram(pK.p); gl.bindFramebuffer(gl.FRAMEBUFFER, T.paint.f); u = pK.u; bind(u, 0, T.scene.t, 'uScene'); bind(u, 1, T.flow.t, 'uFlow');
      gl.uniform2f(u.uTexel, 1 / W, 1 / H); gl.uniform1f(u.uRadius, 5 * dpr); draw(); dirty = false;
    }
    // pointer smear (CPU grid) -> texture
    smear.step(dt, mouse, W / dpr, H / dpr, 90);
    gl.bindTexture(gl.TEXTURE_2D, smTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, smear.c, smear.r, gl.RG, gl.FLOAT, smear.field);
    gl.useProgram(pD.p); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); const u = pD.u;
    bind(u, 0, T.paint.t, 'uPaint'); bind(u, 1, T.flow.t, 'uFlow'); bind(u, 2, smTex, 'uSmear');
    // relief light: from the screen centre towards the sun (day) or moon (night), as on ardia.dev
    const nb = sm3(Math.min(1, Math.max(0, (S.night - .35) / .3))), ang = p => Math.atan2(H / 2 - p[1], p[0] - W / 2);
    const a0 = ang(sunPx), a1 = a0 + Math.atan2(Math.sin(ang(moonPx) - a0), Math.cos(ang(moonPx) - a0)) * nb;
    gl.uniform2f(u.uRes, W, H); gl.uniform1f(u.uDpr, dpr); gl.uniform1f(u.uRelief, 1.3); gl.uniform1f(u.uTime, time);
    gl.uniform3f(u.uLight, Math.cos(a1) * .62, Math.sin(a1) * .62, .78);
    gl.uniform3f(u.uSpec, mix(1, .45, nb), mix(.9, .55, nb), mix(.72, .75, nb));
    gl.uniform2f(u.uSunPx, sunPx[0], H - sunPx[1]); gl.uniform2f(u.uMoonPx, moonPx[0], H - moonPx[1]);
    gl.uniform1f(u.uSunR, Math.tan(.043) / tanHalf * H / 2); gl.uniform1f(u.uNight, S.night);
    gl.uniform1f(u.uSunVis, sm3(Math.min(1, Math.max(0, (S.sunEl + .03) / .09)))); gl.uniform3fv(u.uGlowCol, S.glow); draw();
    if (tone && toneDirty && !busy) { tone.update(gl, canvas, W, H, dpr); toneDirty = false; }
    if (fx) fx.step(dt, [mouse.x, canvas.clientHeight - mouse.y], mouse.active ? 1 : 0, 1);
    if (busy || fx || !smear.settled) raf = requestAnimationFrame(render);
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(render); };
  const rel = e => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const onMove = e => { [mouse.x, mouse.y] = rel(e); mouse.active = true; kick(); };
  const onLeave = () => { mouse.active = false; };
  const onDown = e => { if (fx) { fx.burst(...rel(e)); kick(); } };
  addEventListener('pointermove', onMove); addEventListener('pointerdown', onDown); document.addEventListener('pointerleave', onLeave);
  const ro = new ResizeObserver(() => { resize(); kick(); }); ro.observe(canvas);
  resize(); render();
  return { destroy() { ro.disconnect(); removeEventListener('pointermove', onMove); removeEventListener('pointerdown', onDown);
    document.removeEventListener('pointerleave', onLeave); cancelAnimationFrame(raf); fx?.destroy(); },
    set timeOfDay(v) { P.timeOfDay = v; dirty = true; toneDirty = true; kick(); } };
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
      const mx = m[0], my = h - m[1];
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
