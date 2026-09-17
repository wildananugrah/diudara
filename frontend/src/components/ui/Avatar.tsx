type Props = {
  initials: string;
  color?: string;
  size?: number;
};

export default function Avatar({ initials, color = "var(--kabut)", size = 36 }: Props) {
  return (
    <div
      className="avatar"
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: color,
        color: "#fff",
        fontSize: size * 0.38,
        fontWeight: 700,
        fontFamily: "var(--font-body)",
      }}
    >
      {initials}
    </div>
  );
}
