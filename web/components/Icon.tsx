/// One glyph from the self-hosted Material Symbols Rounded subset
/// (globals.css). Decorative by default: the words beside it carry the
/// meaning, so screen readers skip it unless `label` is given.
export function Icon({
  name,
  size = 20,
  fill = false,
  className = "",
  label,
}: {
  name: string;
  size?: number;
  fill?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={`icon ${className}`}
      style={{ fontSize: size, fontVariationSettings: `"opsz" 20, "wght" 400, "FILL" ${fill ? 1 : 0}` }}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
    >
      {name}
    </span>
  );
}
