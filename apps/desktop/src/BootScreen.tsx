export function BootScreen({ message, title }: { message?: string; title: string }) {
  return (
    <main className="boot-screen">
      <section className="boot-screen__panel" role="status">
        <span className="boot-screen__eyebrow">Tuneforge</span>
        <h1>{title}</h1>
        {message ? <p>{message}</p> : null}
      </section>
    </main>
  );
}
