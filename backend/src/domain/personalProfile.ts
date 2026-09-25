// These fields are shared by the personal editor and tutor onboarding.
export const PERSONAL_FIELDS = ['photoURL', 'dateOfBirth', 'gender', 'province', 'ward', 'district', 'address', 'coordinates'] as const;
export const personalFields = (data: Record<string, any>) => Object.fromEntries(
  PERSONAL_FIELDS.filter(key => data[key] !== undefined && (data[key] !== null || key === 'coordinates')).map(key => [key, data[key]]),
);
const updatedAt = (data: Record<string, any>) => {
  const value = data.updatedAt;
  return typeof value?.toMillis === 'function' ? value.toMillis() : (value?.seconds ?? value?._seconds ?? 0) * 1000;
};
export function resolvePersonalProfile(user: Record<string, any>, personal: Record<string, any> = {}, tutor: Record<string, any> = {}) {
  // Older accounts may only have a tutor profile. Prefer the most recently saved
  // shared fields, while keeping identity/contact fields owned by users.
  const sources = updatedAt(tutor) > updatedAt(personal) ? [personal, tutor] : [tutor, personal];
  return {...user, ...personalFields(sources[0]), ...personalFields(sources[1])};
}
