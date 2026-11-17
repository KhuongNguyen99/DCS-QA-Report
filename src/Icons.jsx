import React from "react";
const paths = {
  equipment: (
    <>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 7h8M8 11h5M16 15v3M9 15h2" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <path d="M3 10h18M10 10v11" />
    </>
  ),
  device: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M10 7h4M10 11h4M10 15h4M3 7h4m10 0h4M3 17h4m10 0h4" />
    </>
  ),
  report: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6M8 13h8M8 17h6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="m10 3-1 3-3 1-3 3 2 2-2 2 3 3 3 1 1 3h4l1-3 3-1 3-3-2-2 2-2-3-3-3-1-1-3z" />
    </>
  ),
  camera: (
    <>
      <path d="M4 6h4l2-3h4l2 3h4a1 1 0 0 1 1 1v12H3V7a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  scan: (
    <>
      <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M3 12h18" />
      <path d="M8 7v2m4-2v2m4-2v2M8 15v2m4-2v2m4-2v2" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <path d="m9 5 7 7-7 7" />,
  back: <path d="m15 5-7 7 7 7" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  download: (
    <>
      <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 16V4m-5 5 5-5 5 5M4 17v4h16v-4" />
    </>
  ),
  search: (
    <>
      <circle cx="10" cy="10" r="6" />
      <path d="m15 15 6 6" />
    </>
  ),
  cloud: (
    <>
      <path d="M6 18a5 5 0 0 1-1-10 7 7 0 0 1 13-1 5.5 5.5 0 0 1 0 11H6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  comment: (
    <path d="M21 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3Z" />
  ),
  refresh: (
    <>
      <path d="M20 7a9 9 0 0 0-15 0L3 10m0-6v6h6m-5 7a9 9 0 0 0 15 0l2-3m0 6v-6h-6" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6m0-10v1" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  plus: <path d="M12 4v16M4 12h16" />,
  logout: (
    <>
      <path d="M9 4H4v16h5m6-15 7 7-7 7m-7-7h14" />
    </>
  ),
};
export default function Icon({ name, size = 20, ...props }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.info}
    </svg>
  );
}
