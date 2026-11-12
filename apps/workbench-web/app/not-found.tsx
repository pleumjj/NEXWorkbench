import Link from 'next/link';
export default function NotFound() {
  return (
    <div className="boot boot-inline">
      <h1>This page isn’t part of NEX Workbench.</h1>
      <p><Link href="/">Back to Home</Link></p>
    </div>
  );
}
