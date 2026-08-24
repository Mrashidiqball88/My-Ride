import { useEffect, useMemo, useState, type ComponentType } from "react";
import { modules } from "./.generated/mockup-components";

type LoadedComponent = ComponentType;

function getPreviewKey(pathname: string) {
  const previewPath = pathname.replace(/^\/__mockup/, "").replace(/^\/preview\//, "");
  const segments = previewPath.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const componentName = segments.pop();
  return `./components/mockups/${segments.join("/")}/${componentName}.tsx`;
}

function PreviewUnavailable() {
  return (
    <main style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: 24, fontFamily: "Inter, sans-serif", background: "#111827", color: "#e5e7eb", textAlign: "center" }}>
      <div>
        <strong style={{ display: "block", fontSize: 16 }}>Mockup preview unavailable</strong>
        <span style={{ display: "block", marginTop: 8, color: "#94a3b8", fontSize: 13 }}>Choose a component from the canvas frame.</span>
      </div>
    </main>
  );
}

export default function App() {
  const key = useMemo(() => getPreviewKey(window.location.pathname), []);
  const [Component, setComponent] = useState<LoadedComponent | null>(null);

  useEffect(() => {
    if (!key || !modules[key]) {
      setComponent(null);
      return;
    }

    let cancelled = false;
    const componentName = key.split("/").at(-1)?.replace(".tsx", "");
    modules[key]()
      .then((module) => {
        const candidate = module[componentName ?? ""] ?? module.default;
        if (!cancelled && typeof candidate === "function") {
          setComponent(() => candidate as LoadedComponent);
        }
      })
      .catch(() => {
        if (!cancelled) setComponent(null);
      });

    return () => {
      cancelled = true;
    };
  }, [key]);

  if (!key) return <PreviewUnavailable />;
  if (!Component) return <PreviewUnavailable />;
  return <Component />;
}
