/* Gellhaus 3D-Engine 2 (hp-engine.js)
   Grundlage: three.js r187 als assets/three-r187.min.js (globale Variable THREE, gebaut mit engine/build-three.sh).
   Diese Datei ist handgeschrieben und braucht keinen Build-Schritt. Sie stellt window.HP3D bereit:

     const E = HP3D.create(viewElement, {lowfi, ground})
     E.render()            ein Bild sofort zeichnen; steht die Ansicht still, wird sie danach in Ruhe verfeinert
     E.renderStill(n)      sofort n verfeinerte Bilder überlagern (für PDF, Foto, Bildexport)
     E.setSun(dir)         Sonnenrichtung (Vector3, zur Sonne zeigend); Himmel, Licht, Nebel und Spiegelungen folgen
     E.fitShadow(b,h)      Schattenbereich an die Hallengröße anpassen
     E.shadowDirty()       nach jeder Geometrieänderung: Schattenkarte neu rechnen
     E.mat, E.tex, E.geo   Materialien, Texturen und Geometrie-Helfer für den Hallenaufbau
     E.exportGLB(root)     Modell als GLB (für AR)

   Bildaufbau je Bild: Szene in ein HDR-Zwischenbild mit 4-facher Kantenglättung, Umgebungsverschattung (GTAO) aus dem
   Tiefenbild, Beschriftungen darüber, dann Tonwertkurve (Khronos PBR Neutral, farbtreu für RAL-Töne) und sRGB.
   Im Stillstand werden Bilder mit leicht versetzter Kamera und Sonne überlagert: glatte Kanten, weiche Schattenränder. */
(function(){
"use strict";
const T=window.THREE;
if(!T){window.HP3D=null;return}
const V3=T.Vector3;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
const mix3=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
function rng(seed){let a=seed>>>0;return()=>{a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const halton=(i,b)=>{let f=1,r=0;while(i>0){f/=b;r+=f*(i%b);i=Math.floor(i/b)}return r};

/* ====================== Himmel ======================
   Analytischer Himmel mit Sonnenstand, Dunst am Horizont, Abendrot, Wolken (Rauschen) und Sternen.
   Derselbe Shader liefert das sichtbare Bild und (ohne Sonnenscheibe) die Umgebungsbeleuchtung. */
const SKY_VS=`
varying vec3 vDir;
void main(){
  vDir=normalize(position);
  vec4 mv=modelViewMatrix*vec4(position,0.0);
  gl_Position=projectionMatrix*vec4(mv.xyz,1.0);
  gl_Position.z=gl_Position.w;
}`;
const SKY_FS=`
uniform vec3 sunDir;
uniform float disc;
uniform float cloud;
uniform vec3 groundCol;
uniform float sat;
varying vec3 vDir;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float vnoise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x),mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x),u.y);}
float fbm(vec2 p){float a=0.5,s=0.0;for(int i=0;i<OCT;i++){s+=a*vnoise(p);p=p*2.03+vec2(17.1,9.7);a*=0.5;}return s;}
void main(){
  vec3 d=normalize(vDir);
  float se=sunDir.y;
  float day=smoothstep(-0.10,0.18,se);
  float dusk=smoothstep(-0.30,0.02,se)*(1.0-smoothstep(0.02,0.36,se));
  float mu=max(d.y,0.0);
  float hz=exp(-mu*5.5);
  vec3 zen=mix(vec3(0.004,0.008,0.022),vec3(0.075,0.215,0.60),day);
  vec3 hor=mix(vec3(0.02,0.03,0.06),vec3(0.60,0.74,0.93),day);
  vec3 c=mix(zen,hor,hz);
  vec2 sa=normalize(sunDir.xz+vec2(1e-4)),da=normalize(d.xz+vec2(1e-4));
  float toward=pow(max(dot(sa,da)*0.5+0.5,0.0),3.0);
  c=mix(c,vec3(1.0,0.46,0.15)*(0.30+0.95*toward),dusk*hz*(0.30+0.70*toward));
  float cs=max(dot(d,sunDir),0.0);
  vec3 sunCol=mix(vec3(1.0,0.50,0.20),vec3(1.0,0.96,0.88),smoothstep(0.0,0.45,se));
  float up=smoothstep(-0.12,0.05,se);
  c+=sunCol*(pow(cs,6.0)*0.08+pow(cs,60.0)*0.30+pow(cs,800.0)*1.1)*up;
  if(d.y>0.0&&cloud>0.0){
    vec2 p=d.xz/(d.y+0.14)*1.35;
    float n=fbm(p+vec2(3.1,1.7))*0.78+fbm(p*2.9+vec2(11.0,5.0))*0.22;
    float th=0.66-cloud*0.26;
    float dens=smoothstep(th,th+0.24,n)*smoothstep(0.015,0.20,d.y);
    float sh=fbm(p+sa*0.22+vec2(3.1,1.7));
    float lit=clamp((n-sh)*3.0+0.55,0.0,1.0);
    vec3 cl=mix(hor*0.62+zen*0.25,sunCol*1.18*(0.25+0.75*day)+hor*0.12,lit)*(0.10+0.90*max(day,dusk*0.8));
    c=mix(c,cl,dens*0.92);
  }
  c+=sunCol*disc*smoothstep(0.99994,0.99998,cs)*30.0*up;
  if(day<0.6&&d.y>0.02){
    vec3 q=floor(d*520.0);
    float h=hash(q.xy+q.z*17.31);
    c+=vec3(0.75,0.80,1.0)*step(0.9975,h)*(1.0-day/0.6)*smoothstep(0.02,0.30,d.y)*0.6;
  }
  if(d.y<0.0){
    vec3 g=groundCol*(0.05+0.95*day)*(0.55+0.9*max(se,0.0))*mix(vec3(1.0),sunCol,0.5);
    c=mix(c,g,smoothstep(0.0,-0.18,d.y));
  }
  c=mix(vec3(dot(c,vec3(0.2126,0.7152,0.0722))),c,sat);
  gl_FragColor=vec4(c,1.0);
}`;
function skyModel(dir){
  const se=dir.y,day=smooth(-0.10,0.18,se),dusk=smooth(-0.30,0.02,se)*(1-smooth(0.02,0.36,se));
  let hor=mix3([0.02,0.03,0.06],[0.60,0.74,0.93],day);
  hor=mix3(hor,[0.62,0.36,0.20],dusk*0.42);
  const sunCol=mix3([1.0,0.50,0.20],[1.0,0.96,0.88],smooth(0,0.45,se));
  return{se,day,dusk,hor,sunCol};
}
function skyMaterial(oct,disc,sat){
  return new T.ShaderMaterial({uniforms:{sunDir:{value:new V3(0.5,0.58,0.64).normalize()},disc:{value:disc},cloud:{value:0.55},groundCol:{value:new T.Color(0.34,0.36,0.27)},sat:{value:sat}},
    defines:{OCT:oct},vertexShader:SKY_VS,fragmentShader:SKY_FS,side:T.BackSide,depthWrite:false,fog:false});
}

/* ====================== Ausgabe-Shader ====================== */
const FS_VS=`precision highp float;uniform mat4 modelViewMatrix;uniform mat4 projectionMatrix;attribute vec3 position;attribute vec2 uv;varying vec2 vUv;void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`;
/* HDR-Zwischenbild -> Bildschirm: Tonwertkurve, sRGB, feines Rauschen gegen Farbstufen im Himmel */
const OUT_FS=`precision highp float;
uniform sampler2D tDiffuse;uniform float weight;uniform float keepAlpha;
#include <tonemapping_pars_fragment>
#include <colorspace_pars_fragment>
varying vec2 vUv;
void main(){
  vec4 c=texture2D(tDiffuse,vUv);
  /* Deckkraft nur beim freigestellten Bild (Hoffoto) auswerten, sonst ist das Bild immer deckend */
  float a=mix(1.0,clamp(c.a,0.0,1.0),keepAlpha);
  vec3 rgb=a>0.001?c.rgb/a:vec3(0.0);
  rgb=NeutralToneMapping(rgb);
  rgb=sRGBTransferOETF(vec4(rgb,1.0)).rgb;
  float n=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
  rgb+=(n-0.5)/255.0;
  gl_FragColor=vec4(rgb*a,a)*weight;
}`;
const COPY_FS=`precision highp float;uniform sampler2D tDiffuse;uniform float weight;varying vec2 vUv;void main(){gl_FragColor=texture2D(tDiffuse,vUv)*weight;}`;
const AO_FS=`precision highp float;uniform sampler2D tAO;uniform float intensity;varying vec2 vUv;void main(){float ao=texture2D(tAO,vUv).r;gl_FragColor=vec4(vec3(mix(1.0,ao,intensity)),1.0);}`;

/* ====================== Engine ====================== */
const E_eco=(opt,soft)=>opt.eco===undefined?soft:!!opt.eco;
function create(view,opt){
  opt=Object.assign({lowfi:false,ground:0.14},window.HP3D_OPT||{},opt||{});
  const E={T,opt,flags:{night:false,inside:false},sunDir:new V3(0.5,0.58,0.64).normalize(),night:false,ENV:[]};
  const GROUND=opt.ground;
  /* Der volle Bildaufbau braucht ein Zwischenbild mit hohem Helligkeitsumfang. Fehlt das (sehr alte Grafik), wird direkt gezeichnet. */
  let hdrOk=false,soft=false;try{const gl=document.createElement("canvas").getContext("webgl2");hdrOk=!!(gl&&(gl.getExtension("EXT_color_buffer_float")||gl.getExtension("EXT_color_buffer_half_float")));
    const di=gl.getExtension("WEBGL_debug_renderer_info");soft=/swiftshader|llvmpipe|softpipe|software|basic render/i.test(String(di?gl.getParameter(di.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER)))}catch(e){}
  /* Sparbetrieb: Rechner ohne Grafikkarte (Software-Darstellung, etwa am Terminalserver) zeichnen direkt und etwas kleiner */
  const eco=E_eco(opt,soft);
  const direct=!!opt.lowfi||opt.pipeline==="direct"||!hdrOk||eco;
  const renderer=new T.WebGLRenderer({antialias:direct,alpha:true,powerPreference:"high-performance",preserveDrawingBuffer:false});
  E.renderer=renderer;
  renderer.setClearColor(0x000000,0);
  renderer.outputColorSpace=T.SRGBColorSpace;
  renderer.toneMapping=T.NeutralToneMapping;renderer.toneMappingExposure=1;
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
  renderer.localClippingEnabled=true;
  const MAXAN=Math.min(16,renderer.capabilities.getMaxAnisotropy());
  view.prepend(renderer.domElement);
  const scene=new T.Scene();E.scene=scene;
  const camera=new T.PerspectiveCamera(32,4/3,0.3,3200);E.camera=camera;

  /* ---------- Texturen ---------- */
  const texCache={};
  function canvasTex(key,drawFn,w,h,srgb=true){if(texCache[key])return texCache[key];const c=document.createElement("canvas");c.width=w;c.height=h;drawFn(c.getContext("2d"),w,h);
    const t=new T.CanvasTexture(c);t.wrapS=t.wrapT=T.RepeatWrapping;if(srgb)t.colorSpace=T.SRGBColorSpace;t.anisotropy=MAXAN;texCache[key]=t;return t}
  /* Relief -> Normalenkarte. fn(u,v) liefert die Höhe 0..1, sx/sy die Steilheit */
  function reliefTex(key,w,h,fn,sx,sy){if(texCache[key])return texCache[key];const c=document.createElement("canvas");c.width=w;c.height=h;const g=c.getContext("2d"),im=g.createImageData(w,h),hs=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)hs[y*w+x]=fn((x+0.5)/w,(y+0.5)/h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const dx=(hs[y*w+(x+1)%w]-hs[y*w+(x+w-1)%w])*sx,dy=(hs[((y+1)%h)*w+x]-hs[((y+h-1)%h)*w+x])*sy,l=Math.hypot(dx,dy,1),i=(y*w+x)*4;
      im.data[i]=(-dx/l*0.5+0.5)*255;im.data[i+1]=(dy/l*0.5+0.5)*255;im.data[i+2]=(1/l*0.5+0.5)*255;im.data[i+3]=255}
    g.putImageData(im,0,0);const t=new T.CanvasTexture(c);t.wrapS=t.wrapT=T.RepeatWrapping;t.anisotropy=MAXAN;texCache[key]=t;return t}
  const trapH=u=>{const t=(u*4)%1;return t<.2?1:t<.32?1-(t-.2)/.12:t<.68?0:t<.8?(t-.68)/.12:1};
  const ribH=u=>{const t=(u*4)%1;return t<.05?1:t<.15?1-(t-.05)/.1:t<.85?0:t<.95?(t-.85)/.1:1};
  const grayRow=(key,w,fn)=>canvasTex(key,(g,W,H)=>{for(let x=0;x<W;x++){const v=Math.round(fn((x+0.5)/W)*255);g.fillStyle=`rgb(${v},${v},${v})`;g.fillRect(x,0,1,H)}},w,4);
  const grayCol=(key,h,fn)=>canvasTex(key,(g,W,H)=>{for(let y=0;y<H;y++){const v=Math.round(fn(1-(y+0.5)/H)*255);g.fillStyle=`rgb(${v},${v},${v})`;g.fillRect(0,y,W,1)}},4,h);
  const rep=(t,x,y)=>{t.repeat.set(x,y);return t};
  const speck=(g,w,h,r,n,a,s=2)=>{for(let i=0;i<n;i++){const d=r()<0.5?0:255;g.fillStyle=`rgba(${d},${d},${d},${a})`;g.fillRect(r()*w,r()*h,s,s)}};
  const blobs=(g,w,h,r,n,a,q0,q1)=>{for(let i=0;i<n;i++){const x=r()*w,y=r()*h,q=q0+r()*q1,d=r()<0.5?0:255;for(const ox of[-w,0,w])for(const oy of[-h,0,h]){const gr=g.createRadialGradient(x+ox,y+oy,0,x+ox,y+oy,q);gr.addColorStop(0,`rgba(${d},${d},${d},${a})`);gr.addColorStop(1,`rgba(${d},${d},${d},0)`);g.fillStyle=gr;g.fillRect(x+ox-q,y+oy-q,2*q,2*q)}}};
  /* Alle UV-Koordinaten sind in Metern. Texturen sind neutrale Helligkeits- und Reliefmuster, die Farbe kommt vom Material (RAL-Ton). */
  const TX=E.tex={
    tzC:()=>rep(grayRow("tzC",512,u=>{const t=(u*4)%1;const flank=(t>.2&&t<.32)||(t>.68&&t<.8);return flank?0.80:0.90+0.10*trapH(u)}),1/0.828,1),
    tzN:()=>rep(reliefTex("tzN",512,4,u=>trapH(u),7,0),1/0.828,1),
    ribC:()=>rep(grayRow("ribC",512,u=>0.92+0.08*ribH(u)),1,1),
    ribN:()=>rep(reliefTex("ribN",512,4,u=>ribH(u),6,0),1,1),
    pnC:()=>rep(grayRow("pnC",1024,u=>{const d=Math.min(u,1-u);return d<0.005?0.42:d<0.012?0.86:0.985+0.015*Math.cos(u*40*Math.PI)}),1,1),
    pnN:()=>rep(reliefTex("pnN",1024,4,u=>smooth(0.003,0.014,Math.min(u,1-u))+0.06*Math.cos(u*40*Math.PI),5,0),1,1),
    secC:()=>rep(grayCol("secC",256,v=>{const d=Math.min(v,1-v);return d<0.012?0.5:d<0.03?0.9:1}),1,2),
    secN:()=>rep(reliefTex("secN",4,256,(u,v)=>smooth(0.006,0.04,Math.min(v,1-v))+0.07*Math.cos(v*12*Math.PI),0,4.5),1,2),
    rolC:()=>rep(grayCol("rolC",32,v=>0.70+0.30*Math.sin(v*Math.PI)),1,10),
    rolN:()=>rep(reliefTex("rolN",4,32,(u,v)=>Math.sqrt(Math.sin(v*Math.PI)),0,2.6),1,10),
    conc:()=>rep(canvasTex("conc",(g,w,h)=>{g.fillStyle="#f1f1f0";g.fillRect(0,0,w,h);const r=rng(9);blobs(g,w,h,r,90,.06,30,110);speck(g,w,h,r,26000,.04)},1024,1024),1/5,1/5),
    /* Hallenboden: geglätteter Beton mit Scheinfugen im 6-m-Raster */
    floor:()=>rep(canvasTex("floor",(g,w,h)=>{g.fillStyle="#f3f3f1";g.fillRect(0,0,w,h);const r=rng(31);blobs(g,w,h,r,120,.05,40,150);speck(g,w,h,r,20000,.03);g.fillStyle="rgba(0,0,0,.28)";g.fillRect(0,0,w,2);g.fillRect(0,0,2,h)},1024,1024),1/6,1/6),
    pave:()=>rep(canvasTex("pave",(g,w,h)=>{g.fillStyle="#9c9c9c";g.fillRect(0,0,w,h);const r=rng(13),bw=w/10,bh=h/20;for(let j=0;j<20;j++)for(let i=-1;i<10;i++){const v=216+r()*24|0;g.fillStyle=`rgb(${v},${v},${v+1})`;g.fillRect(i*bw+(j%2)*bw/2+1.5,j*bh+1.5,bw-3,bh-3)}
        blobs(g,w,h,r,40,.035,40,120);speck(g,w,h,r,9000,.03)},1024,1024),1/2,1/2),
    paveN:()=>rep(reliefTex("paveN",512,512,(u,v)=>{const j=Math.floor(v*20),fx=(u*10+(j%2)*0.5)%1,fy=(v*20)%1;return smooth(0,0.07,Math.min(fx,1-fx))*smooth(0,0.14,Math.min(fy,1-fy))},2.2,2.2),1/2,1/2),
    grain:()=>rep(canvasTex("grain",(g,w,h)=>{g.fillStyle="#cfcfcf";g.fillRect(0,0,w,h);const r=rng(17);for(let i=0;i<60000;i++){const v=105+r()*150|0;g.fillStyle=`rgba(${v},${v},${v-6},.7)`;g.fillRect(r()*w,r()*h,1+r()*2.5,1+r()*2.5)}},512,512),1/1.5,1/1.5),
    road:()=>canvasTex("road",(g,w,h)=>{g.fillStyle="#cfcfcf";g.fillRect(0,0,w,h);const r=rng(19);for(let i=0;i<30000;i++){const v=150+r()*105|0;g.fillStyle=`rgba(${v},${v},${v},.5)`;g.fillRect(r()*w,r()*h,2,2)}g.fillStyle="#fff";g.globalAlpha=0.95;g.fillRect(0,h*0.03,w,5);g.fillRect(0,h*0.97-5,w,5);g.fillRect(0,h/2-3,w/2,6)},512,256),
    pv:()=>rep(canvasTex("pv",(g,w,h)=>{g.fillStyle="#c9ced6";g.fillRect(0,0,w,h);g.fillStyle="#131d36";g.fillRect(5,5,w-10,h-10);g.strokeStyle="rgba(150,165,195,.5)";g.lineWidth=1.5;for(let i=1;i<6;i++){g.beginPath();g.moveTo(5+i*(w-10)/6,5);g.lineTo(5+i*(w-10)/6,h-5);g.stroke()}for(let j=1;j<10;j++){g.beginPath();g.moveTo(5,5+j*(h-10)/10);g.lineTo(w-5,5+j*(h-10)/10);g.stroke()}},192,320),1/1.13,1/1.72),
    zinc:()=>rep(canvasTex("zinc",(g,w,h)=>{g.fillStyle="#e8e8e8";g.fillRect(0,0,w,h);const r=rng(41);for(let i=0;i<1400;i++){const x=r()*w,y=r()*h,q=5+r()*16,v=r()<0.5?255:120;g.fillStyle=`rgba(${v},${v},${v},${0.05+r()*0.08})`;g.beginPath();g.moveTo(x,y);for(let k=0;k<5;k++)g.lineTo(x+(r()-0.5)*q*2,y+(r()-0.5)*q*2);g.closePath();g.fill()}},512,512),1/0.6,1/0.6),
    glow:()=>canvasTex("glow",(g,w,h)=>{const q=g.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);q.addColorStop(0,"rgba(255,226,170,.75)");q.addColorStop(.4,"rgba(255,214,150,.28)");q.addColorStop(1,"rgba(255,210,140,0)");g.fillStyle=q;g.fillRect(0,0,w,h)},128,128),
    blob:()=>canvasTex("blob",(g,w,h)=>{const q=g.createRadialGradient(w/2,h/2,0,w/2,h/2,w/2);q.addColorStop(0,"rgba(0,0,0,.62)");q.addColorStop(.5,"rgba(0,0,0,.38)");q.addColorStop(1,"rgba(0,0,0,0)");g.fillStyle=q;g.fillRect(0,0,w,h)},128,128)
  };
  E.canvasTex=canvasTex;E.reliefTex=reliefTex;

  /* ---------- Materialien ---------- */
  const MATS={};const M=(k,f)=>MATS[k]||(MATS[k]=f());
  const mk=o=>M("mk"+JSON.stringify(o),()=>new T.MeshStandardMaterial(o));
  const std=(hex,rough=0.7,metal=0)=>mk({color:hex,roughness:rough,metalness:metal});
  /* Blech: tz Trapezblech, pn Sandwichpaneel (Wand, liniert), rib Sandwichdach (profilierte Deckschale) */
  const sheet=(kind,hex,xr,hi)=>M("sh"+kind+hex+(xr?"x":"")+(hi?"h":""),()=>{const metalc=hex==="#a5a8a6";
    const m=new T.MeshStandardMaterial({color:hex,map:TX[kind+"C"](),normalMap:TX[kind+"N"](),roughness:metalc?0.38:0.5,metalness:metalc?0.75:0.0});
    if(xr){m.transparent=true;m.opacity=0.16;m.depthWrite=false}if(hi){m.emissive=new T.Color(0x2c68ae);m.emissiveIntensity=0.45}return m});
  const liner=kind=>M("li"+kind,()=>new T.MeshStandardMaterial({color:kind==="pn"?0xe9ebe6:0xd0d3cc,normalMap:TX[kind+"N"](),roughness:0.62,metalness:0.0,envMapIntensity:0.6}));
  const MAT=E.mat={M,mk,std,sheet,liner,
    steel:()=>M("steel",()=>new T.MeshStandardMaterial({color:0xb4babd,map:TX.zinc(),roughness:0.5,metalness:0.82})),
    alu:()=>mk({color:0xc6cacc,roughness:0.36,metalness:0.85}),
    zinc:()=>M("zincm",()=>new T.MeshStandardMaterial({color:0xa9b0b4,map:TX.zinc(),roughness:0.46,metalness:0.8})),
    trim:()=>mk({color:0x4a5258,roughness:0.5,metalness:0.35}),
    dark:()=>std(0x24282b,0.85),
    rubber:()=>std(0x161718,0.95),
    yellow:()=>std(0xf2c200,0.5),
    floor:()=>M("floor",()=>new T.MeshStandardMaterial({color:0xb7b5ae,map:TX.floor(),roughness:0.62,metalness:0,envMapIntensity:0.45})),
    conc:()=>M("conc",()=>new T.MeshStandardMaterial({color:0xb0aea7,map:TX.conc(),roughness:0.93})),
    pave:()=>M("pave",()=>new T.MeshStandardMaterial({color:0xa3a29f,map:TX.pave(),normalMap:TX.paveN(),roughness:0.9})),
    gravel:()=>M("gravel",()=>new T.MeshStandardMaterial({color:0xb9b4a6,map:TX.grain(),roughness:1})),
    asphalt:()=>M("asph",()=>new T.MeshStandardMaterial({color:0x56595b,map:TX.road(),roughness:0.93})),
    glass:()=>M("glass"+(E.flags.night?1:0),()=>{const m=new T.MeshPhysicalMaterial({color:0x1f2c35,roughness:0.03,metalness:0.0,transparent:true,opacity:0.72,envMapIntensity:2.2,specularIntensity:1,ior:1.52});
      if(E.flags.night){m.emissive=new T.Color(0xffd9a0);m.emissiveIntensity=1.6;m.opacity=0.9}return m}),
    poly:()=>M("poly"+(E.flags.night?1:0)+(E.flags.inside?1:0),()=>new T.MeshPhysicalMaterial({color:0xeef4f6,roughness:0.32,transparent:true,opacity:0.84,side:T.DoubleSide,
      emissive:new T.Color(E.flags.night?0xfff0c8:0xdfe9ee),emissiveIntensity:E.flags.night?1.8:E.flags.inside?1.1:0.12})),
    sec:()=>M("sec",()=>new T.MeshStandardMaterial({color:0xd3d6d8,map:TX.secC(),normalMap:TX.secN(),roughness:0.42,metalness:0.25})),
    rol:()=>M("rol",()=>new T.MeshStandardMaterial({color:0xc2c7ca,map:TX.rolC(),normalMap:TX.rolN(),roughness:0.38,metalness:0.7})),
    pv:()=>M("pvm",()=>{const m=new T.MeshPhysicalMaterial({color:0xffffff,map:TX.pv(),roughness:0.12,metalness:0.2,clearcoat:1,clearcoatRoughness:0.04,envMapIntensity:1.4});m.userData.hex="#16233f";return m}),
    lamp:()=>M("lamp"+(E.flags.night||E.flags.inside?1:0),()=>mk({color:0xfff6dc,emissive:0xfff0cc,emissiveIntensity:E.flags.night||E.flags.inside?4:0.6,roughness:0.4})),
    glowDecal:()=>M("glowd",()=>new T.MeshBasicMaterial({map:TX.glow(),transparent:true,depthWrite:false,blending:T.AdditiveBlending,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3})),
    paint:(hex)=>M("paint"+hex,()=>new T.MeshPhysicalMaterial({color:hex,roughness:0.35,metalness:0.25,clearcoat:0.9,clearcoatRoughness:0.08}))
  };

  /* ---------- Geometrie-Helfer ---------- */
  function boxGeo(w,h,d){const g=new T.BoxGeometry(w,h,d),uv=g.attributes.uv,sc=[[d,h],[d,h],[w,d],[w,d],[w,h],[w,h]];for(let f=0;f<6;f++)for(let i=0;i<4;i++){const k=f*4+i;uv.setXY(k,uv.getX(k)*sc[f][0],uv.getY(k)*sc[f][1])}return g}
  function box(w,h,d,m,x,y,z,shadow=true){const g=new T.Mesh(boxGeo(w,h,d),m);g.position.set(x,y,z);g.castShadow=shadow;g.receiveShadow=true;return g}
  function cyl(r,h,m,x,y,z,seg=14,shadow=true){const g=new T.Mesh(new T.CylinderGeometry(r,r,h,seg),m);g.position.set(x,y,z);g.castShadow=shadow;g.receiveShadow=true;return g}
  const UP=new V3(0,1,0);
  function rod(p,q,r,m,shadow=false){const a=new V3(...p),b=new V3(...q),d=b.clone().sub(a),len=d.length();const g=new T.Mesh(new T.CylinderGeometry(r,r,len,8),m);g.position.copy(a).addScaledVector(d,0.5);g.quaternion.setFromUnitVectors(UP,d.normalize());g.castShadow=shadow;g.receiveShadow=true;return g}
  function mergeGeos(list){list=list.map(g=>g.index?g.toNonIndexed():g);const out=new T.BufferGeometry();
    for(const n of["position","normal","uv","color"]){if(!list.length||!list.every(g=>g.attributes[n]))continue;const size=list[0].attributes[n].itemSize;let len=0;for(const g of list)len+=g.attributes[n].count*size;const arr=new Float32Array(len);let o=0;for(const g of list){const a=g.attributes[n];arr.set(a.array.subarray(0,a.count*size),o);o+=a.count*size}out.setAttribute(n,new T.BufferAttribute(arr,size))}return out}
  /* mehrere Teile zu einem Netz mit Materialgruppen (für bewegliche Torblätter) */
  function mergeParts(parts,mats){const used=[...new Set(parts.map(p=>p[1]))].sort((a,b)=>a-b),geos=[],groups=[];let o=0;
    for(const mi of used){let n=0;for(const p of parts)if(p[1]===mi){const g=p[0].index?p[0].toNonIndexed():p[0];geos.push(g);n+=g.attributes.position.count}groups.push([o,n,used.indexOf(mi)]);o+=n}
    const geo=mergeGeos(geos);groups.forEach(g=>geo.addGroup(...g));const m=new T.Mesh(geo,used.map(i=>mats[i]));m.castShadow=true;m.receiveShadow=true;return m}
  function partBox(w,h,d,x,y,z){const g=boxGeo(w,h,d).toNonIndexed();g.translate(x,y,z);return g}
  /* Platte aus einer Kontur (Wand oder Dachfläche): außen Blech, innen Innenschale */
  function plate(shape,t,mo,mi,cast=true){const m=new T.Mesh(new T.ExtrudeGeometry(shape,{depth:t,bevelEnabled:false,curveSegments:1}),mo);m.castShadow=cast;m.receiveShadow=true;const out=[m];
    if(mi){const g=new T.ShapeGeometry(shape,1),ix=g.index.array;for(let i=0;i<ix.length;i+=3){const a=ix[i+1];ix[i+1]=ix[i+2];ix[i+2]=a}const n=g.attributes.normal;for(let i=0;i<n.count;i++)n.setXYZ(i,0,0,-1);g.translate(0,0,-0.012);const li=new T.Mesh(g,mi);li.castShadow=false;li.receiveShadow=true;out.push(li)}
    return out}
  function polyShape(pts,holes){const sh=new T.Shape();pts.forEach((p,i)=>i?sh.lineTo(p[0],p[1]):sh.moveTo(p[0],p[1]));sh.closePath();for(const h of holes||[]){const p=new T.Path();p.moveTo(h[0],h[2]);p.lineTo(h[0],h[3]);p.lineTo(h[1],h[3]);p.lineTo(h[1],h[2]);p.closePath();sh.holes.push(p)}return sh}
  /* Wandkontur: unten Aussparungen für Tore und Türen, oben dem Dach folgend, Fenster als Löcher */
  function wallShape(a,b,bot,topFn,peaks,ops,holes){const pts=[[a,bot]];const ns=ops.map(o=>({a:Math.max(a+0.05,o.u-o.w/2),b:Math.min(b-0.05,o.u+o.w/2),top:o.top})).filter(n=>n.b-n.a>0.1&&n.top>bot+0.05).sort((p,q)=>p.a-q.a);
    const mg=[];for(const n of ns){const l=mg[mg.length-1];if(l&&n.a<l.b+0.06){l.b=Math.max(l.b,n.b);l.top=Math.max(l.top,n.top)}else mg.push({...n})}
    for(const n of mg){const t=Math.min(n.top,topFn(n.a)-0.08,topFn(n.b)-0.08);pts.push([n.a,bot],[n.a,t],[n.b,t],[n.b,bot])}
    pts.push([b,bot],[b,topFn(b)]);for(const p of peaks.filter(p=>p>a+0.01&&p<b-0.01).sort((x,y)=>y-x))pts.push([p,topFn(p)]);pts.push([a,topFn(a)]);
    const hs=(holes||[]).filter(h=>h[0]>a+0.1&&h[1]<b-0.1&&h[2]>bot+0.05&&h[3]<Math.min(topFn(h[0]),topFn(h[1]))-0.1&&!mg.some(n=>h[0]<n.b+0.1&&h[1]>n.a-0.1&&h[2]<n.top+0.1));
    const sh=polyShape(pts,hs);sh.userData={cut:hs};return sh}
  /* Doppel-T-Träger mit ausgerundeten Kehlen, Länge entlang z, Steg senkrecht */
  function beamGeo(h,b,len){const tw=Math.max(0.008,Math.min(0.016,h*0.03)),tf=Math.max(0.012,Math.min(0.03,h*0.06)),r=Math.min(0.02,tf),s=new T.Shape();
    s.moveTo(-b/2,-h/2);s.lineTo(b/2,-h/2);s.lineTo(b/2,-h/2+tf);s.lineTo(tw/2+r,-h/2+tf);s.lineTo(tw/2,-h/2+tf+r);s.lineTo(tw/2,h/2-tf-r);s.lineTo(tw/2+r,h/2-tf);s.lineTo(b/2,h/2-tf);s.lineTo(b/2,h/2);
    s.lineTo(-b/2,h/2);s.lineTo(-b/2,h/2-tf);s.lineTo(-tw/2-r,h/2-tf);s.lineTo(-tw/2,h/2-tf-r);s.lineTo(-tw/2,-h/2+tf+r);s.lineTo(-tw/2-r,-h/2+tf);s.lineTo(-b/2,-h/2+tf);s.closePath();
    const g=new T.ExtrudeGeometry(s,{depth:len,bevelEnabled:false});g.translate(0,0,-len/2);return g}
  function beam(h,b,len,m){const o=new T.Mesh(beamGeo(h,b,len),m);o.castShadow=true;o.receiveShadow=true;return o}
  function column(x,z,ht,cd,b,m,y0=0.25){const g=beamGeo(cd,b,ht);g.rotateX(-Math.PI/2);const o=new T.Mesh(g,m);o.position.set(x,y0+ht/2,z);o.castShadow=true;o.receiveShadow=true;return o}
  function prism(pts,width,m,shadow=true){const g=new T.ExtrudeGeometry(polyShape(pts),{depth:width,bevelEnabled:false});g.translate(0,0,-width/2);const o=new T.Mesh(g,m);o.castShadow=shadow;o.receiveShadow=true;return o}
  function xf(o,m4){o.applyMatrix4(m4);if(o.userData.sdir)o.userData.sdir.transformDirection(m4);return o}
  /* Tonnengewölbe (Lichtband) in Ebenenkoordinaten: x entlang First, s quer, n nach oben */
  function vaultGeo(x0,x1,sA,sB,sag,seg){const W=sB-sA,r=(W*W/4+sag*sag)/(2*sag),a=Math.asin(Math.min(1,W/(2*r))),sc=(sA+sB)/2,nc=sag-r,P=[],N=[],U=[];
    const pt=i=>{const th=-a+2*a*i/seg;return[sc+r*Math.sin(th),nc+r*Math.cos(th),Math.sin(th),Math.cos(th)]};
    for(let i=0;i<seg;i++){const p=pt(i),q=pt(i+1);for(const [x,v] of[[x0,p],[x1,p],[x1,q],[x0,p],[x1,q],[x0,q]]){P.push(x,v[0],v[1]);N.push(0,v[2],v[3]);U.push(x,v[0])}}
    const g=new T.BufferGeometry();g.setAttribute("position",new T.Float32BufferAttribute(P,3));g.setAttribute("normal",new T.Float32BufferAttribute(N,3));g.setAttribute("uv",new T.Float32BufferAttribute(U,2));return g}
  function vaultCap(x,sA,sB,sag,seg){const W=sB-sA,r=(W*W/4+sag*sag)/(2*sag),a=Math.asin(Math.min(1,W/(2*r))),sc=(sA+sB)/2,nc=sag-r,P=[],N=[],U=[];
    for(let i=0;i<seg;i++){const t0=-a+2*a*i/seg,t1=-a+2*a*(i+1)/seg;for(const [s,n] of[[sc,0],[sc+r*Math.sin(t0),nc+r*Math.cos(t0)],[sc+r*Math.sin(t1),nc+r*Math.cos(t1)]]){P.push(x,s,n);N.push(1,0,0);U.push(s,n)}}
    const g=new T.BufferGeometry();g.setAttribute("position",new T.Float32BufferAttribute(P,3));g.setAttribute("normal",new T.Float32BufferAttribute(N,3));g.setAttribute("uv",new T.Float32BufferAttribute(U,2));return g}
  /* flache Fläche auf dem Gelände mit Welt-UV */
  function flatRect(x1,x2,z1,z2,y,m,uvFn){const g=new T.BufferGeometry();g.setAttribute("position",new T.Float32BufferAttribute([x1,y,z1,x1,y,z2,x2,y,z2,x1,y,z1,x2,y,z2,x2,y,z1],3));g.setAttribute("normal",new T.Float32BufferAttribute([0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0],3));
    const f=uvFn||((x,z)=>[x,z]);g.setAttribute("uv",new T.Float32BufferAttribute([...f(x1,z1),...f(x1,z2),...f(x2,z2),...f(x1,z1),...f(x2,z2),...f(x2,z1)],2));const o=new T.Mesh(g,m);o.receiveShadow=true;return o}
  E.geo={boxGeo,box,cyl,rod,mergeGeos,mergeParts,partBox,plate,polyShape,wallShape,beamGeo,beam,column,prism,xf,vaultGeo,vaultCap,flatRect};
  E.rng=rng;

  /* ---------- Himmel, Sonne, Umgebungslicht ---------- */
  const skyMat=skyMaterial(opt.lowfi?4:6,1,1);
  const sky=new T.Mesh(new T.SphereGeometry(1,48,24),skyMat);sky.frustumCulled=false;sky.renderOrder=-10;scene.add(sky);
  const envScene=new T.Scene(),envMat=skyMaterial(4,0,0.55);envScene.add(new T.Mesh(new T.SphereGeometry(10,32,16),envMat));
  const pmrem=new T.PMREMGenerator(renderer);let envRT=null;
  const sun=new T.DirectionalLight(0xfff3df,3.6);sun.castShadow=true;
  const ms=opt.lowfi||eco||renderer.capabilities.maxTextureSize<8192?2048:4096;sun.shadow.mapSize.set(ms,ms);sun.shadow.bias=-0.0002;sun.shadow.normalBias=0.035;sun.shadow.radius=1.4;
  scene.add(sun);scene.add(sun.target);E.sun=sun;
  const FOG=0.0013;scene.fog=new T.FogExp2(0xdfe8f0,FOG);
  const shadowFit={cx:0,cz:0,r:40};
  function placeSun(dir){const s=shadowFit,d=s.r+90;sun.target.position.set(s.cx,0,s.cz);sun.position.set(s.cx+dir.x*d,dir.y*d,s.cz+dir.z*d);sun.target.updateMatrixWorld();sun.updateMatrixWorld()}
  const lightDir=new V3();
  /* Sonnenrichtung setzen (zeigt zur Sonne). Unter dem Horizont: Abendstimmung, die Halle leuchtet von innen. */
  E.setSun=function(dir,cloud){
    E.sunDir.copy(dir).normalize();const m=skyModel(E.sunDir);E.sky=m;
    E.night=m.se<0.035;E.flags.night=E.night;
    for(const mt of[skyMat,envMat]){mt.uniforms.sunDir.value.copy(E.sunDir);if(cloud!==undefined)mt.uniforms.cloud.value=cloud}
    if(envRT)envRT.dispose();envRT=pmrem.fromScene(envScene,0,0.1,50);scene.environment=envRT.texture;
    scene.environmentIntensity=0.85;
    /* Lichtquelle: tagsüber die Sonne, am Abend ein schwaches kühles Restlicht von oben */
    const k=smooth(-0.02,0.20,m.se);
    if(E.night){lightDir.set(E.sunDir.x,0,E.sunDir.z).normalize().multiplyScalar(0.6).setY(0.8).normalize();sun.color.setRGB(0.55,0.66,1.0);sun.intensity=0.35}
    else{lightDir.copy(E.sunDir);if(lightDir.y<0.10){lightDir.y=0.10;lightDir.normalize()}sun.color.setRGB(...m.sunCol);sun.intensity=5.2*k}
    placeSun(lightDir);
    scene.fog.color.setRGB(...m.hor);
    renderer.toneMappingExposure=E.night?1.5:1.0+0.7*(1-smooth(0.0,0.42,m.se));
    if(E.land)E.land.sunChanged(m);
    renderer.shadowMap.needsUpdate=true;
  };
  E.lightDir=lightDir;
  E.fitShadow=function(b,ridge){const cx=(b.x1+b.x2)/2,cz=(b.z1+b.z2)/2,len=clamp(ridge/Math.max(0.12,Math.tan(Math.asin(clamp(lightDir.y,0.05,1)))),5,60);
    shadowFit.cx=cx;shadowFit.cz=cz;shadowFit.r=Math.hypot(b.x2-b.x1,b.z2-b.z1)/2+ridge*0.6+len*0.75+8;
    const c=sun.shadow.camera,r=shadowFit.r;c.left=-r;c.right=r;c.top=r;c.bottom=-r;c.near=1;c.far=2*r+200;c.updateProjectionMatrix();placeSun(lightDir);renderer.shadowMap.needsUpdate=true};
  E.shadowDirty=()=>{renderer.shadowMap.needsUpdate=true};

  /* ---------- Gelände ---------- */
  E.land=buildLand(E,scene,GROUND,canvasTex,mergeGeos,MAXAN);
  const yard=new T.Group();scene.add(yard);E.yard=yard;
  const hall=new T.Group();scene.add(hall);E.hall=hall;
  const labels=new T.Group();scene.add(labels);E.labels=labels;
  E.ENV=[sky,E.land.group,yard];

  /* ---------- Bildaufbau ---------- */
  const fsq=new T.FullScreenQuad(null);
  let rt=null,acc=null,gtao=null,W=0,H=0,pr=1;
  const outMat=new T.RawShaderMaterial({uniforms:{tDiffuse:{value:null},toneMappingExposure:{value:1},weight:{value:1},keepAlpha:{value:0}},vertexShader:FS_VS,fragmentShader:OUT_FS,depthTest:false,depthWrite:false});
  outMat.defines={NEUTRAL_TONE_MAPPING:""};
  const copyMat=new T.RawShaderMaterial({uniforms:{tDiffuse:{value:null},weight:{value:1}},vertexShader:FS_VS,fragmentShader:COPY_FS,depthTest:false,depthWrite:false});
  const aoMat=new T.RawShaderMaterial({uniforms:{tAO:{value:null},intensity:{value:1}},vertexShader:FS_VS,fragmentShader:AO_FS,depthTest:false,depthWrite:false,transparent:true,
    blending:T.CustomBlending,blendEquation:T.AddEquation,blendSrc:T.DstColorFactor,blendDst:T.ZeroFactor,blendSrcAlpha:T.ZeroFactor,blendDstAlpha:T.OneFactor});
  E.eco=eco;const Q=E.quality={ao:!direct,aoMotion:!direct,msaa:direct?0:4,refine:direct?0:(opt.refine??20),prMax:2,pxMax:2.8e6};
  function setup(w,h){
    W=w;H=h;renderer.setSize(w,h,false);camera.aspect=w/h;camera.updateProjectionMatrix();
    if(direct)return;
    const bw=renderer.domElement.width,bh=renderer.domElement.height;
    if(!rt){rt=new T.WebGLRenderTarget(bw,bh,{type:T.HalfFloatType,samples:Q.msaa,depthTexture:new T.DepthTexture(bw,bh)});
      acc=new T.WebGLRenderTarget(bw,bh,{type:T.HalfFloatType,depthBuffer:false});
      gtao=new T.GTAOPass(scene,camera,bw,bh,{depthTexture:rt.depthTexture});gtao.output=T.GTAOPass.OUTPUT.Off;
      gtao.updateGtaoMaterial({radius:1.5,distanceExponent:1.4,thickness:1.6,distanceFallOff:1,scale:1.15,samples:opt.lowfi?8:16,screenSpaceRadius:false});
      gtao.updatePdMaterial({lumaPhi:10,depthPhi:2,normalPhi:3,radius:6,rings:2,samples:12});
    }else{rt.setSize(bw,bh);acc.setSize(bw,bh)}
    gtao.setSize(bw,bh);
  }
  E.resize=function(){const w=view.clientWidth,h=view.clientHeight;if(!w||!h)return false;
    pr=eco?0.8:Math.max(1,Math.min(window.devicePixelRatio||1,Q.prMax,Math.sqrt(Q.pxMax/(w*h))));renderer.setPixelRatio(pr);setup(w,h);return true};
  function cutoutOn(){return !sky.visible}
  /* ein vollständiges Bild: target null = Bildschirm, sonst Sammelbild (additiv) */
  function frame(target,add,withAO){
    sky.position.copy(camera.position);
    if(direct){renderer.setRenderTarget(null);renderer.clear();renderer.render(scene,camera);return}
    const lv=labels.visible;labels.visible=false;
    renderer.setRenderTarget(rt);renderer.autoClear=true;renderer.render(scene,camera);
    renderer.autoClear=false;
    if(withAO&&Q.ao){gtao.render(renderer,null,rt);aoMat.uniforms.tAO.value=gtao.pdRenderTarget.texture;aoMat.uniforms.intensity.value=E.night?0.7:1;fsq.material=aoMat;renderer.setRenderTarget(rt);fsq.render(renderer)}
    labels.visible=lv;
    if(lv&&labels.children.length){const k=1/renderer.toneMappingExposure;
      labels.traverse(o=>{const m=o.material;if(!m||!m.color)return;if(!m.userData.c0)m.userData.c0=m.color.clone();m.color.copy(m.userData.c0).multiplyScalar(k)});
      renderer.setRenderTarget(rt);renderer.render(labels,camera)}
    outMat.uniforms.tDiffuse.value=rt.texture;outMat.uniforms.toneMappingExposure.value=renderer.toneMappingExposure;outMat.uniforms.keepAlpha.value=cutoutOn()?1:0;
    outMat.blending=add?T.CustomBlending:T.NoBlending;if(add){outMat.blendEquation=T.AddEquation;outMat.blendSrc=T.OneFactor;outMat.blendDst=T.OneFactor;outMat.blendSrcAlpha=T.OneFactor;outMat.blendDstAlpha=T.OneFactor}
    fsq.material=outMat;renderer.setRenderTarget(target);if(!target)renderer.clear();fsq.render(renderer);
    renderer.autoClear=true;renderer.setRenderTarget(null);
  }
  /* Verfeinerung im Stillstand */
  let accN=0,accRAF=0,accTimer=0,lastT=0,slow=0,fast=0;
  const jit=new V3(),ax=new V3(),ay=new V3();
  function jitterOn(i){
    const bw=renderer.domElement.width,bh=renderer.domElement.height;
    camera.setViewOffset(bw,bh,halton(i+1,2)-0.5,halton(i+1,3)-0.5,bw,bh);
    /* Sonne um ihren Mittelpunkt streuen: weiche, nach außen breiter werdende Schattenränder */
    const a=halton(i+1,5)*6.2832,rr=Math.sqrt(halton(i+1,7))*Math.tan((E.night?2.2:0.75)*Math.PI/180);
    ax.crossVectors(lightDir,UP).normalize();ay.crossVectors(lightDir,ax).normalize();
    jit.copy(lightDir).addScaledVector(ax,Math.cos(a)*rr).addScaledVector(ay,Math.sin(a)*rr).normalize();placeSun(jit);renderer.shadowMap.needsUpdate=true;
  }
  function jitterOff(){camera.clearViewOffset();placeSun(lightDir);renderer.shadowMap.needsUpdate=true}
  function present(){copyMat.uniforms.tDiffuse.value=acc.texture;copyMat.uniforms.weight.value=1/accN;fsq.material=copyMat;renderer.setRenderTarget(null);renderer.clear();fsq.render(renderer)}
  function accStep(){
    if(accN===0){renderer.setRenderTarget(acc);renderer.clear();renderer.setRenderTarget(null)}
    jitterOn(accN);frame(acc,true,true);accN++;
  }
  function cancelRefine(){if(accRAF){cancelAnimationFrame(accRAF);accRAF=0}clearTimeout(accTimer);if(accN){accN=0;jitterOff()}}
  function refineLoop(){accRAF=0;if(accN>=Q.refine){jitterOff();accN=0;E.refined=true;return}
    accStep();present();
    if(accN>=Q.refine){jitterOff();accN=0;E.refined=true;return}
    accRAF=requestAnimationFrame(refineLoop)}
  E.refined=false;
  E.render=function(){
    if(!W&&!E.resize())return;
    cancelRefine();E.refined=false;
    const now=performance.now(),dt=now-lastT;lastT=now;
    /* Bildrate während der Bewegung beobachten und bei Bedarf die Verschattung nur noch im Stillstand rechnen */
    if(!direct&&!opt.fixed){if(dt<500){if(dt>45){fast=0;if(++slow>8){slow=0;if(Q.aoMotion)Q.aoMotion=false;else if(Q.prMax>1){Q.prMax=1;E.resize()}}}else if(dt<24){slow=Math.max(0,slow-1);if(Q.prMax<2&&++fast>240){fast=0;Q.prMax=2;E.resize()}}}else slow=0}
    frame(null,false,Q.aoMotion);
    if(Q.refine>0&&!E.noRefine)accTimer=setTimeout(()=>{accRAF=requestAnimationFrame(refineLoop)},180);
  };
  /* sofort ein verfeinertes Standbild (blockiert kurz): für Aufnahmen */
  E.renderStill=function(n){
    if(!W&&!E.resize())return;cancelRefine();
    if(direct||!n){frame(null,false,true);return}
    accN=0;for(let i=0;i<n;i++)accStep();present();accN=0;jitterOff();
  };
  /* Bild als Data-URL. opt: {w,h,frames,type,quality} */
  E.snapshot=function(o){o=o||{};const was={W,H,pr};
    if(o.w&&o.h){renderer.setPixelRatio(1);setup(o.w,o.h)}
    E.renderStill(o.frames??8);
    const url=renderer.domElement.toDataURL(o.type||"image/jpeg",o.quality??0.9);
    if(o.w&&o.h){renderer.setPixelRatio(was.pr);setup(was.W,was.H)}
    return url};
  E.setCutout=function(on){for(const o of E.ENV)o.visible=!on;scene.fog.density=on?0:FOG};
  /* Schnittebenen für alle Materialien der Halle (null = aus). Bei mehreren Ebenen bleibt stehen, was mindestens eine Ebene behält. */
  const clipped=new Set();
  E.setClip=function(planes){
    if(!planes){for(const m of clipped){m.clippingPlanes=null;m.clipIntersection=false;m.needsUpdate=true}clipped.clear();renderer.shadowMap.needsUpdate=true;return}
    hall.traverse(o=>{if(!o.isMesh)return;for(const m of Array.isArray(o.material)?o.material:[o.material]){if(m.clippingPlanes!==planes){m.clippingPlanes=planes;m.clipIntersection=planes.length>1;m.clipShadows=true;m.needsUpdate=true;clipped.add(m)}}})};
  E.dispose=function(){cancelRefine();renderer.dispose();pmrem.dispose()};
  E.exportGLB=exportGLB;
  E.setSun(E.sunDir,0.55);
  E.resize();
  return E;
}

/* ====================== Gelände: Wiese, Felder, Baumreihe am Horizont, Bäume ====================== */
function buildLand(E,scene,GROUND,canvasTex,mergeGeos,MAXAN){
  const land=new T.Group();scene.add(land);
  const R=rng(8);
  /* Wiese: Farbe aus mehrstufigem Rauschen im Shader, dadurch ohne sichtbare Kachelung bis zum Horizont */
  const grass=new T.Mesh(new T.CircleGeometry(2600,64).rotateX(-Math.PI/2),new T.MeshStandardMaterial({color:0x8a9160,roughness:1,metalness:0}));
  grass.material.onBeforeCompile=sh=>{
    sh.vertexShader=sh.vertexShader.replace("#include <common>","#include <common>\nvarying vec3 vWp;").replace("#include <begin_vertex>","#include <begin_vertex>\nvWp=(modelMatrix*vec4(transformed,1.0)).xyz;");
    sh.fragmentShader=sh.fragmentShader.replace("#include <common>",`#include <common>
varying vec3 vWp;
float gh(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float gn(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(gh(i),gh(i+vec2(1.0,0.0)),u.x),mix(gh(i+vec2(0.0,1.0)),gh(i+vec2(1.0,1.0)),u.x),u.y);}`)
      .replace("#include <color_fragment>",`#include <color_fragment>
{vec2 p=vWp.xz;float dist=length(vWp-cameraPosition);float near=1.0-smoothstep(30.0,170.0,dist);float mid=1.0-smoothstep(150.0,700.0,dist);
float n1=gn(p*0.019+3.7),n2=gn(p*0.083+7.3),n3=gn(p*0.61+1.9),n4=gn(p*3.9);
float k=0.80+0.30*(n1-0.5)+0.26*(n2-0.5)*mid+0.22*(n3-0.5)*near+0.20*(n4-0.5)*near;
vec3 tint=mix(vec3(1.07,1.0,0.80),vec3(0.91,1.0,0.90),smoothstep(0.25,0.75,n2*0.6+n1*0.4));
diffuseColor.rgb*=k*tint;}`)};
  grass.position.y=GROUND;grass.receiveShadow=true;land.add(grass);
  /* Ackerflächen in der Ferne */
  const rowTex=canvasTex("rows",(g,w,h)=>{g.fillStyle="#fff";g.fillRect(0,0,w,h);for(let y=0;y<h;y+=8){g.fillStyle="rgba(0,0,0,.16)";g.fillRect(0,y,w,3)}const r=rng(2);for(let i=0;i<900;i++){g.fillStyle=`rgba(0,0,0,${r()*0.08})`;g.fillRect(r()*w,r()*h,3,3)}},64,64);
  [[-470,-150,-380,-130,0xb9a66c,0],[-125,180,-460,-170,0x5d7a3c,1],[200,480,-360,-90,0x8b7853,0],[190,500,110,380,0xa9ad58,1],[-490,-170,90,360,0x678642,0],[-140,160,130,400,0xbfae74,1],[-900,-520,-300,300,0x7d8f4c,0],[540,920,-240,260,0xa7a05e,1]].forEach(([x1,x2,z1,z2,c,rot])=>{
    const w=x2-x1,d=z2-z1,g=new T.PlaneGeometry(w,d);g.rotateX(-Math.PI/2);const uv=g.attributes.uv;for(let i=0;i<uv.count;i++){const a=uv.getX(i)*w/2.2,b=uv.getY(i)*d/2.2;uv.setXY(i,rot?b:a,rot?a:b)}
    const m=new T.Mesh(g,new T.MeshStandardMaterial({color:c,map:rowTex,roughness:1}));m.position.set((x1+x2)/2,GROUND+0.04,(z1+z2)/2);land.add(m)});
  /* ferne Baumreihe mit Höfen und Windrädern als Horizont */
  const tl=canvasTex("treeline",(g,W,Hh)=>{const R2=rng(21);
    for(let i=0;i<5;i++){const x=120+R2()*(W-240),h=74+R2()*36;g.strokeStyle="#e9edf0";g.lineWidth=2.4;g.beginPath();g.moveTo(x,Hh);g.lineTo(x,Hh-h);g.stroke();g.lineWidth=1.8;const a0=R2()*6;for(let b=0;b<3;b++){const a=a0+b*2.094;g.beginPath();g.moveTo(x,Hh-h);g.lineTo(x+Math.cos(a)*30,Hh-h+Math.sin(a)*30);g.stroke()}}
    for(let i=0;i<9;i++){const x=R2()*(W-80),w=26+R2()*34,h=9+R2()*8;g.fillStyle=R2()<0.5?"#d8d2c4":"#b9b3a6";g.fillRect(x,Hh-h-14,w,h+14);g.fillStyle=R2()<0.6?"#8c4f3f":"#5e6468";g.beginPath();g.moveTo(x-3,Hh-h-14);g.lineTo(x+w/2,Hh-h-14-w*0.3);g.lineTo(x+w+3,Hh-h-14);g.closePath();g.fill()}
    for(let layer=0;layer<3;layer++){const n=layer===0?420:300;for(let i=0;i<n;i++){const x=R2()*W,r=(layer===0?7:10)+R2()*(layer===2?17:12),y=Hh-(layer===0?13:6)-R2()*(layer===2?10:22);const l=17+layer*4+R2()*9;g.fillStyle=`hsl(${92+R2()*26},${22+R2()*14}%,${l}%)`;
        for(const dx of[-W,0,W]){g.beginPath();g.ellipse(x+dx,y,r*(0.8+R2()*0.5),r,0,0,7);g.fill()}}}
    g.fillStyle="#3c5433";g.fillRect(0,Hh-10,W,10)},4096,160);
  tl.repeat.x=3;tl.wrapT=T.ClampToEdgeWrapping;
  const ring=new T.Mesh(new T.CylinderGeometry(560,560,34,96,1,true),new T.MeshBasicMaterial({map:tl,transparent:true,alphaTest:0.4,side:T.BackSide}));ring.position.y=GROUND+17;land.add(ring);

  /* Bäume: Stamm und Äste als Körper, Krone aus vielen Blattflächen mit ausgeschnittenem Laub */
  const leafTex=canvasTex("leaf",(g,w,h)=>{const r=rng(77);g.clearRect(0,0,w,h);
    for(let i=0;i<340;i++){const a=r()*6.283,rad=Math.pow(r(),0.62)*w*0.46,x=w/2+Math.cos(a)*rad,y=h/2+Math.sin(a)*rad*0.94,s=8+r()*10,rot=r()*6.283,l=20+r()*24;
      g.save();g.translate(x,y);g.rotate(rot);g.fillStyle=`hsl(${78+r()*34},${34+r()*22}%,${l}%)`;g.beginPath();g.ellipse(0,0,s,s*0.46,0,0,6.283);g.fill();g.strokeStyle=`hsla(${80+r()*20},35%,${l+5}%,.35)`;g.lineWidth=1;g.beginPath();g.moveTo(-s*0.8,0);g.lineTo(s*0.8,0);g.stroke();g.restore()}},256,256);
  leafTex.wrapS=leafTex.wrapT=T.ClampToEdgeWrapping;
  const leafG=[],trunkG=[],trees=[];
  const hash=(x,z)=>{const s=Math.sin(x*127.1+z*311.7)*43758.5453;return s-Math.floor(s)};
  function treeAt(x,z,sc,kind){
    const slim=kind==="slim",hT=(slim?4.2:3.6)*sc,rx=(slim?2.3:4.3)*sc*(0.9+R()*0.2),ry=(slim?5.2:3.5)*sc*(0.9+R()*0.2),cy=hT+ry*0.78;
    const m4=new T.Matrix4().makeTranslation(x,GROUND,z);
    const tr=new T.CylinderGeometry(0.14*sc,0.38*sc,hT+ry*0.7,9).toNonIndexed();tr.translate(0,(hT+ry*0.7)/2,0);tr.applyMatrix4(m4);trunkG.push(tr);
    for(let b=0;b<4;b++){const a=R()*6.283,len=(slim?2.4:3.6)*sc,bg=new T.CylinderGeometry(0.05*sc,0.14*sc,len,6).toNonIndexed();bg.translate(0,len/2,0);bg.rotateZ(slim?0.45:0.85);bg.rotateY(a);bg.translate(0,hT*(0.78+b*0.14),0);bg.applyMatrix4(m4);trunkG.push(bg)}
    const tone=0.78+R()*0.4,warm=R();
    const n=slim?40:54;
    for(let i=0;i<n;i++){
      const th=R()*6.283,ph=Math.acos(1-2*R()),rad=i<6?0.25+R()*0.2:0.55+R()*0.45;
      let dx=Math.sin(ph)*Math.cos(th),dy=Math.cos(ph),dz=Math.sin(ph)*Math.sin(th);if(dy<-0.55)dy=-0.55*R();
      const px=dx*rx*rad,py=dy*ry*rad,pz=dz*rx*rad,s=(slim?1.5:2.1)*sc*(0.8+R()*0.6);
      const g=new T.PlaneGeometry(2*s,2*s).toNonIndexed();
      /* Fläche grob nach außen gedreht, mit Streuung */
      const q=new T.Quaternion().setFromUnitVectors(new V3(0,0,1),new V3(dx+(R()-0.5)*0.9,dy*0.6+(R()-0.5)*0.9+0.25,dz+(R()-0.5)*0.9).normalize());
      g.applyQuaternion(q);g.rotateY(0);g.translate(px,py+cy,pz);
      const p=g.attributes.position,nr=g.attributes.normal,cs=new Float32Array(p.count*3);
      for(let k=0;k<p.count;k++){const vx=p.getX(k)/rx,vy=(p.getY(k)-cy)/ry,vz=p.getZ(k)/rx,l=Math.hypot(vx,vy,vz)||1;
        const nx=vx/l,ny=vy/l*0.8+0.45,nz=vz/l,nl=Math.hypot(nx,ny,nz);nr.setXYZ(k,nx/nl,ny/nl,nz/nl);
        const shd=(0.42+0.58*Math.min(1,l))*(0.72+0.34*(vy*0.5+0.5))*tone;cs[k*3]=shd*(0.92+0.22*warm);cs[k*3+1]=shd;cs[k*3+2]=shd*(0.86-0.1*warm)}
      g.setAttribute("color",new T.BufferAttribute(cs,3));g.applyMatrix4(m4);leafG.push(g)}
    trees.push({x,z,rx,ry,cy});
  }
  [[-74,-38,1.25,"oak"],[-60,-52,1.05,"slim"],[-34,-66,1.35,"oak"],[-12,-74,1,"slim"],[14,-72,1.2,"oak"],[40,-70,1.15,"slim"],[62,-58,1.3,"oak"],[80,-38,1,"oak"],[92,-12,1.2,"slim"],[-86,-8,1.1,"oak"],[-94,22,1.25,"oak"],[96,24,1.1,"oak"],[-70,-70,1.4,"oak"],[76,-76,1.3,"slim"],[104,-50,1.2,"oak"],[-104,-40,1.15,"slim"],[-110,64,1.3,"oak"],[112,70,1.2,"oak"],[-150,-110,1.5,"oak"],[150,-120,1.4,"oak"],[-170,10,1.3,"slim"],[176,-30,1.35,"oak"],[30,-130,1.5,"oak"],[-60,-150,1.3,"slim"]].forEach(a=>treeAt(...a));
  const leafMat=new T.MeshStandardMaterial({map:leafTex,vertexColors:true,roughness:0.9,metalness:0,side:T.DoubleSide,alphaTest:0.42,alphaToCoverage:true,color:0xa9c97c});
  /* weiche, kugelige Beleuchtung: Normalen zeigen von der Kronenmitte nach außen, auch auf der Rückseite */
  leafMat.onBeforeCompile=sh=>{sh.fragmentShader=sh.fragmentShader.replace("#include <normal_fragment_begin>","#include <normal_fragment_begin>\nnormal=normalize(vNormal);")};
  const leaves=new T.Mesh(mergeGeos(leafG),leafMat);leaves.castShadow=false;leaves.receiveShadow=false;land.add(leaves);
  const trunks=new T.Mesh(mergeGeos(trunkG),new T.MeshStandardMaterial({color:0x4f4033,roughness:1}));land.add(trunks);
  /* Baumschatten als weiche Flecken, folgen dem Sonnenstand */
  const shMat=new T.MeshBasicMaterial({map:E.tex.blob(),transparent:true,depthWrite:false,opacity:0.8,side:T.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
  let treeSh=null;
  function sunChanged(m){
    if(treeSh){land.remove(treeSh);treeSh.geometry.dispose();treeSh=null}
    ring.material.color.setScalar(0.10+0.90*m.day);leafMat.color.setHex(0xa9c97c).multiplyScalar(0.22+0.78*m.day);
    if(m.day<0.25)return;
    const d=E.lightDir,hl=Math.hypot(d.x,d.z)||1,ux=d.x/hl,uz=d.z/hl,cot=Math.min(4,hl/Math.max(0.2,d.y)),gs=[];
    for(const t of trees){const off=t.cy*cot,along=t.ry*cot+t.rx,ac=t.rx*1.15,cx=t.x-ux*off,cz=t.z-uz*off;
      const P=[],U=[0,0,1,0,1,1,0,0,1,1,0,1];for(const [a,b] of[[-1,-1],[1,-1],[1,1],[-1,-1],[1,1],[-1,1]])P.push(cx+ux*a*along-uz*b*ac,GROUND+0.06,cz+uz*a*along+ux*b*ac);
      const g=new T.BufferGeometry();g.setAttribute("position",new T.Float32BufferAttribute(P,3));g.setAttribute("uv",new T.Float32BufferAttribute(U,2));gs.push(g)}
    treeSh=new T.Mesh(mergeGeos(gs),shMat);shMat.opacity=0.75*smooth(0.25,0.8,m.day);land.add(treeSh);
  }
  return{group:land,sunChanged};
}

/* ====================== GLB-Export (für AR): Geometrie je Farbe zusammengefasst, ohne Texturen ====================== */
function exportGLB(root){
  const groups={};const v=new V3(),n=new V3(),nm=new T.Matrix3();root.updateMatrixWorld(true);
  root.traverse(o=>{if(!o.isMesh||o.isSprite||!o.visible||o.userData.noExport)return;let geo=o.geometry;if(geo.index)geo=geo.toNonIndexed();const P=geo.attributes.position,N=geo.attributes.normal;if(!N)return;nm.getNormalMatrix(o.matrixWorld);
    const parts=Array.isArray(o.material)?geo.groups.map(g=>[o.material[g.materialIndex],g.start,g.start+g.count]):[[o.material,0,P.count]];
    for(const [m,i0,i1] of parts){if(!m||!m.color||(m.transparent&&m.opacity<0.3))continue;const c=m.userData.hex?new T.Color(m.userData.hex):m.color;const hex="#"+c.getHexString();
      const key=hex+(m.transparent?"t":"")+Math.round((m.metalness||0)*4);const g=groups[key]||(groups[key]={c:[c.r,c.g,c.b],alpha:m.transparent?m.opacity:1,metal:m.metalness||0,rough:m.roughness??0.7,pos:[],nor:[]});
      for(let i=i0;i<i1;i++){v.fromBufferAttribute(P,i).applyMatrix4(o.matrixWorld);g.pos.push(v.x,v.y,v.z);n.fromBufferAttribute(N,i).applyMatrix3(nm).normalize();g.nor.push(n.x,n.y,n.z)}}});
  const json={asset:{version:"2.0",generator:"Gellhaus Hallenplaner"},scene:0,scenes:[{nodes:[]}],nodes:[],meshes:[],materials:[],accessors:[],bufferViews:[],buffers:[{byteLength:0}]};
  const bufs=[];let off=0;
  const addView=(arr)=>{const b=new Uint8Array(arr.buffer);const pad=(4-b.byteLength%4)%4;bufs.push(b);if(pad)bufs.push(new Uint8Array(pad));json.bufferViews.push({buffer:0,byteOffset:off,byteLength:b.byteLength});off+=b.byteLength+pad;return json.bufferViews.length-1};
  Object.values(groups).forEach((g,i)=>{const pos=new Float32Array(g.pos),nor=new Float32Array(g.nor);const mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];for(let k=0;k<pos.length;k+=3)for(let d=0;d<3;d++){mn[d]=Math.min(mn[d],pos[k+d]);mx[d]=Math.max(mx[d],pos[k+d])}
    const pv=addView(pos),nv=addView(nor);json.accessors.push({bufferView:pv,componentType:5126,count:pos.length/3,type:"VEC3",min:mn,max:mx},{bufferView:nv,componentType:5126,count:nor.length/3,type:"VEC3"});
    json.materials.push({pbrMetallicRoughness:{baseColorFactor:[g.c[0],g.c[1],g.c[2],g.alpha],metallicFactor:Math.min(0.6,g.metal),roughnessFactor:g.rough},alphaMode:g.alpha<1?"BLEND":"OPAQUE",doubleSided:true});
    json.meshes.push({primitives:[{attributes:{POSITION:json.accessors.length-2,NORMAL:json.accessors.length-1},material:i}]});json.nodes.push({mesh:i});json.scenes[0].nodes.push(i)});
  json.buffers[0].byteLength=off;const bin=new Uint8Array(off);let p=0;bufs.forEach(b=>{bin.set(b,p);p+=b.byteLength});
  const js=new TextEncoder().encode(JSON.stringify(json));const jpad=(4-js.byteLength%4)%4;const total=12+8+js.byteLength+jpad+8+bin.byteLength;
  const out=new ArrayBuffer(total);const dv=new DataView(out);const u8=new Uint8Array(out);let q=0;
  dv.setUint32(0,0x46546C67,true);dv.setUint32(4,2,true);dv.setUint32(8,total,true);q=12;
  dv.setUint32(q,js.byteLength+jpad,true);dv.setUint32(q+4,0x4E4F534A,true);q+=8;u8.set(js,q);q+=js.byteLength;for(let i=0;i<jpad;i++)u8[q++]=0x20;
  dv.setUint32(q,bin.byteLength,true);dv.setUint32(q+4,0x004E4942,true);q+=8;u8.set(bin,q);
  return new Blob([out],{type:"model/gltf-binary"});
}

window.HP3D={create,version:"2.0",three:T.REVISION,rng,clamp,smooth};
})();
