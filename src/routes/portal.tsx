import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { CheckCircle2, Clock, ExternalLink, ImagePlus, LogOut, PauseCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/appointment-dialog";
import { ClientCard, ClientLogo } from "@/components/client-card";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";
import { getMiCliente, guardarMiCliente, registrarIngreso, type Cliente } from "@/lib/clientes.functions";
import { useI18n } from "@/i18n";
import { RoutePending } from "@/components/route-pending";

export const Route = createFileRoute("/portal")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Portal de clientes — MJ Estudio Contable" },
      { name: "description", content: "Espacio para clientes de MJ Estudio Contable: registrá tu empresa o marca." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: Portal,
});

type Mi = Awaited<ReturnType<typeof getMiCliente>>;

function Shell({ children }: { children: ReactNode }) {
  return <section className="min-h-[calc(100vh-5rem)] bg-muted px-4 py-14 md:py-20"><div className="mx-auto w-full max-w-5xl">{children}</div></section>;
}

function Portal() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [recovery, setRecovery] = useState(false);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "PASSWORD_RECOVERY") setRecovery(true);
      setSession(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  // Mientras se revisa la sesión se muestra la pantalla de carga animada (la misma de toda la web).
  if (session === undefined) return <Shell><RoutePending /></Shell>;
  if (recovery && session) return <Shell><NewPassword done={() => setRecovery(false)} /></Shell>;
  if (!session) return <Shell><Access /></Shell>;
  return <Shell><Space session={session} /></Shell>;
}

/* ───────────── ingreso y registro ───────────── */

function Access() {
  const { t } = useI18n();
  const c = t.clients;
  const [tab, setTab] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [sentTo, setSentTo] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const redirect = typeof window !== "undefined" ? `${window.location.origin}/portal` : "/portal";

  async function login(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setError(""); setInfo("");
    const { error } = await supabase.auth.signInWithPassword({ email: String(f.get("email")).trim(), password: String(f.get("password")) });
    setBusy(false);
    if (error) setError((error as { code?: string }).code === "email_not_confirmed" ? c.checkText(String(f.get("email")).trim()) : c.loginError);
  }
  async function register(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")).trim();
    setBusy(true); setError(""); setInfo("");
    const { data, error } = await supabase.auth.signUp({ email, password: String(f.get("password")), options: { emailRedirectTo: redirect, data: { nombre_contacto: String(f.get("name")).trim() } } });
    setBusy(false);
    if (error) {
      const code = (error as { code?: string }).code ?? "";
      const text = error.message.toLowerCase();
      if (code === "weak_password" || text.includes("weak") || text.includes("password")) return setError(c.weakPassword);
      if (code === "user_already_exists" || code === "email_exists" || text.includes("already")) return setError(c.emailExists);
      if (code.startsWith("over_") || text.includes("rate limit")) return setError(c.rateLimit);
      if (code === "email_address_invalid" || text.includes("invalid")) return setError(c.invalidEmail);
      if (text.includes("sending") || text.includes("email")) return setError(c.emailSendError);
      return setError(`${c.registerError} (${code || error.message})`);
    }
    // Si el correo ya tenía cuenta, Supabase responde sin error pero sin identidades.
    if (data.user && (data.user.identities?.length ?? 0) === 0) return setError(c.emailExists);
    if (!data.session) setSentTo(email);
  }
  async function google() {
    setError("");
    const r = await lovable.auth.signInWithOAuth("google", { redirect_uri: redirect });
    if (r.error) setError(c.googleError);
  }
  async function forgot() {
    const email = emailRef.current?.value.trim();
    if (!email) { emailRef.current?.focus(); return; }
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirect });
    setInfo(c.resetSent);
  }

  if (sentTo) {
    return (
      <div className="mx-auto max-w-md rounded-2xl border border-border bg-background p-8 text-center shadow-xl">
        <CheckCircle2 className="mx-auto size-12 text-success" />
        <h1 className="mt-4 font-display text-3xl">{c.checkTitle}</h1>
        <p className="mt-3 leading-7 text-muted-foreground">{c.checkText(sentTo)}</p>
        <Button variant="outline" className="mt-6" onClick={() => { setSentTo(""); setTab("login"); }}>{c.tabLogin}</Button>
      </div>
    );
  }
  return (
    <div className="mx-auto grid max-w-4xl gap-8 md:grid-cols-[1fr_1.1fr] md:items-center">
      <div>
        <p className="eyebrow">MJ Estudio Contable</p>
        <h1 className="mt-3 font-display text-4xl font-semibold leading-tight md:text-5xl">{c.portalTitle}</h1>
        <p className="mt-4 text-lg leading-8 text-muted-foreground">{c.portalText}</p>
      </div>
      <div className="rounded-2xl border border-border bg-background p-7 shadow-xl">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="tablist">
          {(["login", "register"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setError(""); setInfo(""); }} className={`rounded-md py-2 text-sm font-semibold transition ${tab === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>{k === "login" ? c.tabLogin : c.tabRegister}</button>
          ))}
        </div>
        {tab === "login" ? (
          <form onSubmit={login} className="mt-6 grid gap-4">
            <Field label={c.email}><input ref={emailRef} className="field" name="email" type="email" autoComplete="email" required /></Field>
            <Field label={c.password}><input className="field" name="password" type="password" autoComplete="current-password" required /></Field>
            <button type="button" onClick={forgot} className="-mt-1 justify-self-start text-sm font-medium text-primary hover:underline">{c.forgot}</button>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            {info && <p role="status" className="text-sm text-muted-foreground">{info}</p>}
            <Button variant="brand" size="lg" disabled={busy}>{busy ? c.working : c.loginBtn}</Button>
          </form>
        ) : (
          <form onSubmit={register} className="mt-6 grid gap-4">
            <Field label={c.yourName}><input className="field" name="name" autoComplete="name" required minLength={2} maxLength={120} /></Field>
            <Field label={c.email}><input className="field" name="email" type="email" autoComplete="email" required /></Field>
            <Field label={c.password}><input className="field" name="password" type="password" autoComplete="new-password" required minLength={8} /></Field>
            <p className="-mt-2 text-xs text-muted-foreground">{c.passwordHint}</p>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button variant="brand" size="lg" disabled={busy}>{busy ? c.working : c.registerBtn}</Button>
          </form>
        )}
        <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />{c.or}<span className="h-px flex-1 bg-border" /></div>
        <Button variant="outline" className="w-full" onClick={google}>{c.google}</Button>
      </div>
    </div>
  );
}

function NewPassword({ done }: { done: () => void }) {
  const { t } = useI18n();
  const c = t.clients;
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: String(new FormData(e.currentTarget).get("password")) });
    setBusy(false);
    if (error) setMsg(c.saveError);
    else { setMsg(c.newPassDone); window.setTimeout(done, 1500); }
  }
  return (
    <form onSubmit={submit} className="mx-auto grid max-w-md gap-4 rounded-2xl border border-border bg-background p-8 shadow-xl">
      <h1 className="font-display text-3xl">{c.newPassTitle}</h1>
      <Field label={c.password}><input className="field" name="password" type="password" autoComplete="new-password" required minLength={8} /></Field>
      <p className="-mt-2 text-xs text-muted-foreground">{c.passwordHint}</p>
      {msg && <p role="status" className="text-sm text-muted-foreground">{msg}</p>}
      <Button variant="brand" size="lg" disabled={busy}>{c.newPassBtn}</Button>
    </form>
  );
}

/* ───────────── espacio del cliente ───────────── */

function Space({ session }: { session: Session }) {
  const { t } = useI18n();
  const c = t.clients;
  const fetchMine = useServerFn(getMiCliente);
  const ping = useServerFn(registrarIngreso);
  const [mi, setMi] = useState<Mi | null>(null);
  const [error, setError] = useState(false);
  const pinged = useRef(false);
  const load = useCallback(async () => {
    try { setMi(await fetchMine()); setError(false); } catch { setError(true); }
  }, [fetchMine]);
  useEffect(() => { void load(); }, [load, session.user.id]);
  useEffect(() => {
    if (mi?.cliente?.estado === "aprobado" && !pinged.current) {
      pinged.current = true;
      ping().catch(() => {});
    }
  }, [mi, ping]);
  const logout = () => supabase.auth.signOut();

  if (error) return <div className="rounded-2xl bg-background p-8 text-center"><p>{c.saveError}</p><Button className="mt-4" variant="outline" onClick={() => void load()}>↻</Button></div>;
  if (!mi) return <RoutePending />;
  const cl = mi.cliente;
  const nombre = (cl?.nombre_contacto || mi.nombre || mi.email).split(" ")[0]!;

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div><p className="eyebrow">{c.portalTitle}</p><h1 className="mt-2 font-display text-4xl font-semibold">{cl ? c.hello(nombre) : c.profileNewTitle}</h1></div>
        <div className="flex flex-wrap gap-2">
          {mi.esAdmin && <Button variant="outline" asChild><Link to="/admin">{c.goAdmin}</Link></Button>}
          <Button variant="outline" onClick={logout}><LogOut />{c.logout}</Button>
        </div>
      </div>
      {mi.esAdmin && <p className="rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">{c.studioNote}</p>}
      {!cl && <p className="max-w-3xl text-lg leading-8 text-muted-foreground">{c.profileNewText}</p>}
      {cl?.estado === "pendiente" && <Banner icon={<Clock className="size-6 text-primary" />} title={c.pendingTitle} text={c.pendingText(cl.empresa)} />}
      {cl?.estado === "pausado" && <Banner icon={<PauseCircle className="size-6 text-destructive" />} title={c.pausedTitle} text={c.pausedText} />}
      <ProfileForm key={cl?.actualizado_en ?? "nuevo"} session={session} cliente={cl} defaults={{ nombre: mi.nombre }} onSaved={load} />
    </div>
  );
}

function Banner({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="flex gap-4 rounded-2xl border border-border bg-background p-5 shadow-sm">{icon}<div><p className="font-semibold">{title}</p><p className="mt-1 text-muted-foreground">{text}</p></div></div>;
}

type Form = {
  nombre_contacto: string; telefono: string; empresa: string; ruc: string; rubro: string; descripcion: string;
  sitio_web: string; instagram: string; direccion: string; maps_url: string; logo_url: string; mostrar_publico: boolean;
};
const igUser = (url: string | null) => (url ? "@" + (url.match(/instagram\.com\/([^/]+)/)?.[1] ?? "") : "");

/** Busca dónde empieza y termina el dibujo (ignora los bordes blancos o transparentes). */
function contentBox(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const px = ctx.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const empty = px[i + 3]! < 16 || (px[i]! > 242 && px[i + 1]! > 242 && px[i + 2]! > 242);
      if (!empty) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  return x1 < 0 ? { x: 0, y: 0, w, h } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Recorta los bordes vacíos, achica la imagen (máx. 600 px) y la convierte a WEBP antes de subirla. */
async function prepareLogo(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const src = document.createElement("canvas");
  src.width = bmp.width;
  src.height = bmp.height;
  const sctx = src.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(bmp, 0, 0);
  const box = contentBox(sctx, src.width, src.height);
  const pad = Math.round(Math.max(box.w, box.h) * 0.04);
  const cx = Math.max(0, box.x - pad), cy = Math.max(0, box.y - pad);
  const cw = Math.min(src.width - cx, box.w + pad * 2), ch = Math.min(src.height - cy, box.h + pad * 2);
  const scale = Math.min(1, 600 / Math.max(cw, ch));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(cw * scale));
  canvas.height = Math.max(1, Math.round(ch * scale));
  canvas.getContext("2d")!.drawImage(src, cx, cy, cw, ch, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("imagen"))), "image/webp", 0.9));
}

function ProfileForm({ session, cliente, defaults, onSaved }: { session: Session; cliente: Cliente | null; defaults: { nombre: string }; onSaved: () => Promise<void> }) {
  const { t } = useI18n();
  const c = t.clients;
  const save = useServerFn(guardarMiCliente);
  const uid = session.user.id;
  const [f, setF] = useState<Form>({
    nombre_contacto: cliente?.nombre_contacto ?? defaults.nombre, telefono: cliente?.telefono ?? "", empresa: cliente?.empresa ?? "", ruc: cliente?.ruc ?? "",
    rubro: cliente?.rubro ?? "", descripcion: cliente?.descripcion ?? "", sitio_web: cliente?.sitio_web ?? "", instagram: igUser(cliente?.instagram ?? null),
    direccion: cliente?.direccion ?? "", maps_url: cliente?.maps_url ?? "", logo_url: cliente?.logo_url ?? "", mostrar_publico: cliente?.mostrar_publico ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  async function onLogo(file: File | undefined) {
    if (!file) return;
    setMsg(null);
    if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 8 * 1024 * 1024) return setMsg({ ok: false, text: c.logoError });
    setUploading(true);
    try {
      const blob = await prepareLogo(file);
      const path = `${uid}/logo-${Date.now()}.webp`;
      const { error } = await supabase.storage.from("logos-clientes").upload(path, blob, { contentType: "image/webp", upsert: false });
      if (error) throw error;
      set("logo_url", `/logo/${path}`);
    } catch {
      setMsg({ ok: false, text: c.logoError });
    } finally {
      setUploading(false);
    }
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      await save({ data: f });
      setMsg({ ok: true, text: c.saved });
      await onSaved();
    } catch (err) {
      // Los errores de validación llegan como lista en JSON: se muestra el primero si es uno de los nuestros.
      let text = c.saveError;
      try {
        const raw = err instanceof Error ? err.message : "";
        const first = (raw.trim().startsWith("[") ? (JSON.parse(raw) as { message?: string }[])[0]?.message : raw) ?? "";
        if (/Google Maps|web no válida/.test(first)) text = first;
      } catch { /* mensaje genérico */ }
      setMsg({ ok: false, text });
    } finally {
      setBusy(false);
    }
  }

  const preview = { id: "preview", empresa: f.empresa || c.company, rubro: f.rubro || null, descripcion: f.descripcion || null, logo_url: f.logo_url || null, sitio_web: f.sitio_web || null, instagram: f.instagram ? "https://instagram.com/" : null, direccion: f.direccion || null, maps_url: f.maps_url || null };
  const visible = cliente?.estado === "aprobado" && cliente.mostrar_publico && !cliente.oculto;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] [&>*]:min-w-0">
      <form onSubmit={submit} className="grid gap-5 rounded-2xl border border-border bg-background p-6 shadow-sm md:p-8 [&>*]:min-w-0">
        {cliente && <h2 className="font-display text-2xl font-semibold">{c.spaceTitle}</h2>}
        <div className="flex flex-wrap items-center gap-4">
          <ClientLogo cliente={{ empresa: f.empresa || "?", logo_url: f.logo_url || null }} className="h-24 w-32" />
          <div className="grid gap-2">
            <p className="text-sm font-medium">{c.logo}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={uploading} asChild>
                <label className="cursor-pointer"><ImagePlus />{uploading ? c.logoUploading : f.logo_url ? c.logoChange : c.logoUpload}<input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" onChange={(e) => { void onLogo(e.target.files?.[0]); e.target.value = ""; }} /></label>
              </Button>
              {f.logo_url && <Button type="button" variant="ghost" size="sm" onClick={() => set("logo_url", "")}><Trash2 />{c.logoRemove}</Button>}
            </div>
            <p className="max-w-sm text-xs text-muted-foreground">{c.logoHint}</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <Field label={`${c.company} *`}><input className="field" required minLength={2} maxLength={120} value={f.empresa} onChange={(e) => set("empresa", e.target.value)} /></Field>
          <Field label={c.sector}><input className="field" maxLength={80} placeholder={c.sectorPh} value={f.rubro} onChange={(e) => set("rubro", e.target.value)} /></Field>
          <Field label={`${c.contactName} *`}><input className="field" required minLength={2} maxLength={120} value={f.nombre_contacto} onChange={(e) => set("nombre_contacto", e.target.value)} /></Field>
          <Field label={c.phone}><input className="field" type="tel" maxLength={40} value={f.telefono} onChange={(e) => set("telefono", e.target.value)} /></Field>
          <Field label={c.ruc}><input className="field" maxLength={20} value={f.ruc} onChange={(e) => set("ruc", e.target.value)} /></Field>
          <Field label={c.instagramField}><input className="field" maxLength={200} placeholder={c.instagramPh} value={f.instagram} onChange={(e) => set("instagram", e.target.value)} /></Field>
        </div>
        <Field label={c.description}><textarea className="field min-h-24" maxLength={400} value={f.descripcion} onChange={(e) => set("descripcion", e.target.value)} /></Field>
        <p className="-mt-3 text-xs text-muted-foreground">{c.descriptionHint} ({f.descripcion.length}/400)</p>
        <Field label={c.websiteField}><input className="field" type="text" inputMode="url" maxLength={300} placeholder="www.tuempresa.com.py" value={f.sitio_web} onChange={(e) => set("sitio_web", e.target.value)} /></Field>
        <Field label={c.address}><input className="field" maxLength={200} value={f.direccion} onChange={(e) => set("direccion", e.target.value)} /></Field>
        <Field label={c.maps}><input className="field" type="url" maxLength={500} placeholder="https://maps.app.goo.gl/…" value={f.maps_url} onChange={(e) => set("maps_url", e.target.value)} /></Field>
        <p className="-mt-3 text-xs text-muted-foreground">{c.mapsHint}</p>
        <label className="flex items-start gap-3 rounded-xl border border-border p-4 text-sm leading-6"><input type="checkbox" className="mt-1 size-4" checked={f.mostrar_publico} onChange={(e) => set("mostrar_publico", e.target.checked)} />{c.consent}</label>
        {msg && <p role={msg.ok ? "status" : "alert"} className={`text-sm ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</p>}
        <div><Button variant="brand" size="lg" disabled={busy || uploading}>{busy ? c.working : cliente ? c.save : c.sendReview}</Button></div>
      </form>
      <div className="grid h-fit gap-4">
        <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{c.preview}</p>
        <ClientCard cliente={preview} />
        {cliente?.estado === "aprobado" && (
          <div className="rounded-2xl border border-border bg-background p-5 text-sm">
            <p className="flex items-start gap-2">{visible ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <PauseCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}{visible ? c.statusPublic : !cliente.mostrar_publico ? c.statusPrivate : c.statusHidden}</p>
            {visible && <Button variant="link" className="mt-1 h-auto px-0" asChild><Link to="/clientes">{c.seeOnWeb} <ExternalLink /></Link></Button>}
          </div>
        )}
      </div>
    </div>
  );
}
