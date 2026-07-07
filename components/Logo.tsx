// Inline МУ-Плевен brand mark. Placeholder until the official Logo_MU_BG_New.png
// asset is supplied — renders as clean vector (no broken image / 400), scales to
// any size via the className width/height.
export default function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} role="img" aria-label="МУ-Плевен">
      <circle cx="50" cy="50" r="49" fill="#7B1C1C" />
      <circle cx="50" cy="50" r="42" fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1.5" />
      <text
        x="50" y="50" textAnchor="middle" dominantBaseline="central"
        fontFamily="Inter, system-ui, sans-serif" fontWeight="700" fontSize="38" fill="#ffffff"
      >
        МУ
      </text>
    </svg>
  );
}
