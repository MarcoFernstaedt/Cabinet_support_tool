// A QR code for the authenticator setup, drawn in the browser from the setup link: the key never goes to any other service.
// Authenticator apps need dark modules on a light background with a quiet zone, whatever the page's theme.
import { useMemo } from "react";
import qrcode from "qrcode-generator";

export function QrCode({ value, label }: { value: string; label: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    return qr.createSvgTag({ scalable: true, margin: 4, cellSize: 4 });
  }, [value]);
  // The markup is the library's own output for our own text (a drawing of squares), never page content from anywhere else.
  return <div className="qr" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: svg }} />;
}
