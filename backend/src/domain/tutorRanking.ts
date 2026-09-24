// Calendar month in Vietnam, independent of the server's timezone.
export function vietnamMonth(now = new Date()) {
  const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return {
    label: `${month + 1}/${year}`,
    start: Date.UTC(year, month, 1) - 7 * 60 * 60 * 1000,
    end: Date.UTC(year, month + 1, 1) - 7 * 60 * 60 * 1000,
  };
}

export function rankMonthlyTutors(
  applications: {
    tutorId: string;
    jobId: string;
    status: string;
    updatedAt?: { toMillis(): number };
  }[],
  now = new Date(),
) {
  const period = vietnamMonth(now);
  const jobs = new Map<string, Set<string>>();
  for (const item of applications) {
    const date = item.updatedAt?.toMillis();
    if (
      item.status !== 'ACCEPTED' ||
      date === undefined ||
      date < period.start ||
      date >= period.end ||
      date > now.getTime()
    )
      continue;
    const ids = jobs.get(item.tutorId) || new Set<string>();
    ids.add(item.jobId);
    jobs.set(item.tutorId, ids);
  }
  return [...jobs]
    .map(([id, monthlyClasses]) => ({
      id,
      monthlyClasses: monthlyClasses.size,
    }))
    .sort(
      (a, b) => b.monthlyClasses - a.monthlyClasses || a.id.localeCompare(b.id),
    );
}
