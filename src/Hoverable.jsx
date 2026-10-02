import { useState } from "react";

export function Hoverable({ as: As = "div", style, hoverStyle, children, ...rest }) {
  const [hover, setHover] = useState(false);
  const merged = hover && hoverStyle ? { ...style, ...hoverStyle } : style;
  return (
    <As
      style={merged}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...rest}
    >
      {children}
    </As>
  );
}
