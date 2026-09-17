import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCheck, faCircle, faArrowRight } from "@fortawesome/free-solid-svg-icons";
import Header from "../components/layout/Header";

type Msg = { from: "bot" | "user"; text: string };

const script: { bot: string; options?: string[] }[] = [
  { bot: "Halo! Aku Pulse-ID 👋 Aku bakal bantu kamu setup komunitas berbayar dalam beberapa menit. Komunitas kamu tentang apa?", options: ["Bimbel / edukasi", "Coaching bisnis", "Kajian / rohani", "Konten kreator"] },
  { bot: "Mantap! Siapa target audiens utamanya?", options: ["Siswa SMA", "Pelaku UMKM", "Umum", "Sesama kreator"] },
  { bot: "Oke, sekarang soal harga — mau pakai berapa tier membership?", options: ["1 tier saja", "2 tier", "3 tier (disarankan)"] },
  { bot: "Terakhir, kamu mau hubungkan grup WhatsApp/Telegram yang sudah ada, atau bikin baru lewat sistem?", options: ["Hubungkan grup existing", "Buat grup baru"] },
];

const summarySteps = [
  "Menyusun struktur komunitas...",
  "Membuat draf welcome message...",
  "Menyiapkan tier membership...",
  "Menghasilkan halaman checkout...",
];

export default function PulseOnboarding() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Msg[]>([{ from: "bot", text: script[0].bot }]);
  const [step, setStep] = useState(0);
  const [done, setDone] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildStep, setBuildStep] = useState(0);

  const choose = (option: string) => {
    const next = [...messages, { from: "user" as const, text: option }];
    if (step + 1 < script.length) {
      next.push({ from: "bot", text: script[step + 1].bot });
      setMessages(next);
      setStep(step + 1);
    } else {
      setMessages(next);
      setDone(true);
      setBuilding(true);
      let i = 0;
      const interval = setInterval(() => {
        i++;
        setBuildStep(i);
        if (i >= summarySteps.length) {
          clearInterval(interval);
          setBuilding(false);
        }
      }, 700);
    }
  };

  return (
    <>
      <Header title="Pulse-ID" subtitle="AI co-builder — setup komunitas dalam Bahasa Indonesia" insetDivider={false} />
      <div style={{ minHeight: "100vh", display: "flex", justifyContent: "center", padding: 20, background: "var(--awan)" }}>
      <div style={{ width: "100%", maxWidth: 620, display: "flex", flexDirection: "column" }}>
        {/* chat */}
        <div className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 12, minHeight: 380 }}>
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                maxWidth: "82%",
                alignSelf: m.from === "bot" ? "flex-start" : "flex-end",
                background: m.from === "bot" ? "var(--ink-100)" : "var(--langit)",
                color: m.from === "bot" ? "var(--ink-900)" : "var(--awan)",
                padding: "11px 15px",
                borderRadius: 14,
                borderBottomLeftRadius: m.from === "bot" ? 4 : 14,
                borderBottomRightRadius: m.from === "user" ? 4 : 14,
                fontSize: 14,
                lineHeight: 1.5,
              }}
            >
              {m.text}
            </div>
          ))}

          {building && (
            <div style={{ alignSelf: "flex-start", display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
              {summarySteps.map((s, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: i < buildStep ? "var(--hijau-lepas)" : "var(--ink-300)" }}>
                  <span style={{ fontSize: i < buildStep ? 12 : 8 }}>
                    <FontAwesomeIcon icon={i < buildStep ? faCheck : faCircle} />
                  </span>
                  {s}
                </div>
              ))}
            </div>
          )}

          {!done && step < script.length && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
              {script[step].options?.map((opt) => (
                <button key={opt} className="btn btn-ghost btn-sm" onClick={() => choose(opt)}>
                  {opt}
                </button>
              ))}
            </div>
          )}

          {done && !building && (
            <div style={{ marginTop: 12, padding: 16, borderRadius: 12, background: "var(--success-bg)" }}>
              <p style={{ fontSize: 13.5, fontWeight: 600, color: "#2E6248", marginBottom: 4 }}>Komunitas siap dibagikan!</p>
              <p style={{ fontSize: 13, color: "var(--ink-700)", marginBottom: 14 }}>
                Halaman checkout, welcome message, dan struktur channel sudah dibuatkan otomatis. Kamu bisa sesuaikan lagi kapan saja.
              </p>
              <button className="btn btn-primary" onClick={() => navigate("/creator/dashboard")}>
                Buka dashboard creator <FontAwesomeIcon icon={faArrowRight} />
              </button>
            </div>
          )}
        </div>
      </div>
      </div>
    </>
  );
}
