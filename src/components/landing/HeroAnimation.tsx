"use client";

import { useEffect, useRef } from "react";

export default function HeroAnimation() {
  const orb1 = useRef<HTMLDivElement>(null);
  const orb2 = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let frame: number;
    let t = 0;
    function animate() {
      t += 0.008;
      if (orb1.current) {
        orb1.current.style.transform = `translateY(${Math.sin(t) * 12}px) rotate(${t * 8}deg)`;
      }
      if (orb2.current) {
        orb2.current.style.transform = `translateY(${Math.sin(t + 1.5) * 8}px) rotate(${-t * 5}deg)`;
      }
      frame = requestAnimationFrame(animate);
    }
    animate();
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="relative w-full max-w-sm sm:max-w-md lg:max-w-lg xl:max-w-xl" style={{ height: 400 }}>

      {/* Ambient glow behind everything */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div style={{
          width: 320, height: 320,
          background: "radial-gradient(circle, rgba(27,79,232,0.18) 0%, transparent 70%)",
          borderRadius: "50%",
          filter: "blur(20px)",
        }} />
      </div>

      {/* Main server rack — center */}
      <div className="absolute inset-0 flex items-center justify-center" style={{ perspective: "900px" }}>
        <div style={{
          width: 220,
          transform: "rotateY(-18deg) rotateX(8deg)",
          transformStyle: "preserve-3d",
          transition: "transform 0.3s ease",
        }}>
          {/* Rack body */}
          <div className="rounded-2xl overflow-hidden"
            style={{
              background: "linear-gradient(160deg, #1E293B 0%, #0F172A 100%)",
              border: "1px solid rgba(148,163,184,0.15)",
              boxShadow: "0 30px 80px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.06)",
              padding: "20px 18px",
            }}>

            {/* Top indicator row */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex gap-1.5">
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E", boxShadow: "0 0 6px #22C55E" }} />
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E", boxShadow: "0 0 6px #22C55E" }} />
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#FBBF24", boxShadow: "0 0 6px #FBBF24" }} />
              </div>
              <span style={{ fontSize: 9, color: "#64748B", fontFamily: "monospace" }}>SOWSI-SRV-01</span>
            </div>

            {/* Server units */}
            {[
              { label: "WEB-01", load: 72, color: "#3B82F6" },
              { label: "DB-01", load: 45, color: "#22C55E" },
              { label: "CACHE", load: 88, color: "#A855F7" },
              { label: "STORE", load: 31, color: "#0EA5E9" },
              { label: "MAIL", load: 55, color: "#F59E0B" },
            ].map((unit, i) => (
              <div key={unit.label} className="mb-2.5">
                <div className="rounded-lg px-3 py-2.5 flex items-center gap-3"
                  style={{
                    background: "rgba(255,255,255,0.04)",
                    border: "1px solid rgba(255,255,255,0.06)",
                    boxShadow: i === 0 ? "0 0 12px rgba(59,130,246,0.15)" : "none",
                  }}>
                  {/* Blink dot */}
                  <BlinkDot color={unit.color} delay={i * 0.4} />

                  <span style={{ fontSize: 10, color: "#94A3B8", fontFamily: "monospace", width: 44 }}>{unit.label}</span>

                  {/* Bar */}
                  <div className="flex-1 rounded-full overflow-hidden" style={{ height: 4, background: "rgba(255,255,255,0.06)" }}>
                    <div className="h-full rounded-full" style={{
                      width: `${unit.load}%`,
                      background: unit.color,
                      boxShadow: `0 0 6px ${unit.color}80`,
                    }} />
                  </div>

                  <span style={{ fontSize: 9, color: "#64748B", width: 28, textAlign: "right" }}>{unit.load}%</span>
                </div>
              </div>
            ))}

            {/* Bottom port row */}
            <div className="flex gap-1.5 mt-3 justify-center">
              {[...Array(8)].map((_, i) => (
                <div key={i} style={{
                  width: 14, height: 8, borderRadius: 2,
                  background: i < 5 ? "#1D4ED8" : "rgba(255,255,255,0.08)",
                  boxShadow: i < 5 ? "0 0 4px rgba(29,78,216,0.8)" : "none",
                }} />
              ))}
            </div>
          </div>

          {/* 3D side face */}
          <div style={{
            position: "absolute",
            top: 6, right: -14,
            width: 14, height: "calc(100% - 12px)",
            background: "linear-gradient(90deg, #0F172A, #0B1120)",
            borderRadius: "0 6px 6px 0",
            border: "1px solid rgba(148,163,184,0.08)",
            borderLeft: "none",
          }} />

          {/* 3D bottom face */}
          <div style={{
            position: "absolute",
            bottom: -10, left: 6,
            width: "calc(100% - 6px)", height: 10,
            background: "linear-gradient(180deg, #0F172A, #080D18)",
            borderRadius: "0 0 6px 6px",
            border: "1px solid rgba(148,163,184,0.08)",
            borderTop: "none",
          }} />
        </div>
      </div>

      {/* Floating badge — top right */}
      <div ref={orb1} className="absolute top-6 right-4 sm:right-0"
        style={{ filter: "drop-shadow(0 8px 20px rgba(34,197,94,0.3))" }}>
        <div className="rounded-xl px-3 py-2 flex items-center gap-2"
          style={{ background: "rgba(15,23,42,0.9)", border: "1px solid rgba(34,197,94,0.3)", backdropFilter: "blur(12px)" }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E", boxShadow: "0 0 8px #22C55E" }} />
          <span style={{ fontSize: 11, color: "#86EFAC", fontWeight: 600 }}>99.9% Uptime</span>
        </div>
      </div>

      {/* Floating badge — bottom left */}
      <div ref={orb2} className="absolute bottom-10 left-0 sm:-left-4"
        style={{ filter: "drop-shadow(0 8px 20px rgba(27,79,232,0.3))" }}>
        <div className="rounded-xl px-3 py-2 flex items-center gap-2"
          style={{ background: "rgba(15,23,42,0.9)", border: "1px solid rgba(27,79,232,0.4)", backdropFilter: "blur(12px)" }}>
          <span style={{ fontSize: 16 }}>⚡</span>
          <div>
            <div style={{ fontSize: 11, color: "#93C5FD", fontWeight: 600 }}>NVMe SSD</div>
            <div style={{ fontSize: 9, color: "#64748B" }}>10x faster</div>
          </div>
        </div>
      </div>

      {/* Floating badge — middle left */}
      <div className="absolute top-1/2 -translate-y-1/2 left-0 sm:-left-6"
        style={{ animation: "floatBadge 3s ease-in-out infinite", filter: "drop-shadow(0 8px 20px rgba(168,85,247,0.25))" }}>
        <div className="rounded-xl px-3 py-2"
          style={{ background: "rgba(15,23,42,0.9)", border: "1px solid rgba(168,85,247,0.3)", backdropFilter: "blur(12px)" }}>
          <div style={{ fontSize: 11, color: "#D8B4FE", fontWeight: 600 }}>₹99/mo</div>
          <div style={{ fontSize: 9, color: "#64748B" }}>Starting price</div>
        </div>
      </div>

      <style>{`
        @keyframes floatBadge {
          0%, 100% { transform: translateY(-50%) translateY(0px); }
          50% { transform: translateY(-50%) translateY(-8px); }
        }
      `}</style>
    </div>
  );
}

function BlinkDot({ color, delay }: { color: string; delay: number }) {
  return (
    <div style={{
      width: 6, height: 6, borderRadius: "50%",
      background: color,
      boxShadow: `0 0 5px ${color}`,
      animation: `blink 1.8s ${delay}s ease-in-out infinite`,
      flexShrink: 0,
    }}>
      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}
