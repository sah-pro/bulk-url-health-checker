'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div>
      <p className="error-cell">Failed to load batch: {error.message}</p>
      <button onClick={reset}>Try again</button>
    </div>
  );
}
