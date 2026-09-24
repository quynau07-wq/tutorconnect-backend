import {validateSchedule, type ScheduleSlot} from './schedule.js';
export type TutorStatus = 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export const SUBJECTS = ['Toán', 'Ngữ văn', 'Tiếng Anh', 'Vật lý', 'Hóa học', 'Sinh học', 'Lịch sử', 'Địa lý', 'Tin học', 'Khác'];
export const GRADES = [...Array.from({length: 12}, (_, i) => `Lớp ${i + 1}`), 'Đại học', 'Người lớn', 'Khác'];
export type Certificate = {name: string; issuer: string; issuedAt: string; expiresAt: string; image: string};
export type TutorDraft = {
  photoURL: string; dateOfBirth: string; gender: string; province: string; ward: string; district: string; address: string;
  coordinates: {latitude: number; longitude: number} | null;
  university: string; major: string; educationLevel: string; startYear: string; graduationYear: string; educationStatus: string;
  subjects: string[]; grades: string[]; levels: string[];
  experienceYears: string; experienceLevel: string; experience: string; teachingMethod: string; achievements: string;
  teachingModes: string[]; teachingAreas: string; travelRadius: string;
  priceUnit: string; onlinePrice: string; offlinePrice: string;
  availability: ScheduleSlot[]; title: string; bio: string; strengths: string; certificates: Certificate[];
};
export type Verification = {front: string; back: string; portrait: string};
export const emptyTutorDraft = (): TutorDraft => ({
  photoURL: '', dateOfBirth: '', gender: '', province: '', ward: '', district: '', address: '', coordinates: null,
  university: '', major: '', educationLevel: '', startYear: '', graduationYear: '', educationStatus: '',
  subjects: [], grades: [], levels: [], experienceYears: '', experienceLevel: '', experience: '', teachingMethod: '', achievements: '',
  teachingModes: [], teachingAreas: '', travelRadius: '5', priceUnit: 'HOUR', onlinePrice: '', offlinePrice: '',
  availability: [], title: '', bio: '', strengths: '', certificates: [],
});
export const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const validateTutor = (draft: TutorDraft, verification: Verification, step?: number): string | null => {
  const check = (n: number) => step === undefined || step === n;
  if (check(0) && (!draft.photoURL || !validDate(draft.dateOfBirth) || draft.dateOfBirth >= new Date().toISOString().slice(0, 10) || !draft.gender || !draft.province.trim() || !draft.ward?.trim())) return 'Vui lòng thêm ảnh, ngày sinh hợp lệ, giới tính, tỉnh/thành phố và phường/xã.';
  if (check(1) && (!draft.university.trim() || !draft.major.trim() || !draft.educationLevel || !draft.educationStatus || !/^\d{4}$/.test(draft.startYear) || !/^\d{4}$/.test(draft.graduationYear) || Number(draft.startYear) < 1900 || Number(draft.graduationYear) < Number(draft.startYear) || Number(draft.graduationYear) > new Date().getFullYear() + 15)) return 'Vui lòng hoàn thiện học vấn và kiểm tra năm học.';
  if (check(2) && (!draft.subjects.length || !draft.grades.length || !draft.levels.length)) return 'Vui lòng chọn môn, lớp và cấp học có thể dạy.';
  if (check(3) && (!draft.experienceLevel || !/^\d+(\.\d+)?$/.test(draft.experienceYears) || Number(draft.experienceYears) > 80)) return 'Vui lòng chọn mức kinh nghiệm và nhập số năm từ 0 đến 80.';
  const offline = draft.teachingModes.some(mode => mode !== 'ONLINE');
  if (check(2) && (draft.subjects.some(value => !SUBJECTS.includes(value)) || draft.grades.some(value => !GRADES.includes(value)) || draft.levels.some(value => !['Tiểu học', 'THCS', 'THPT', 'Đại học', 'Luyện thi', 'Khác'].includes(value)))) return 'Môn, lớp hoặc cấp học không hợp lệ.';
  if (check(4) && draft.teachingModes.some(value => !['ONLINE', 'LEARNER_HOME', 'TUTOR_HOME'].includes(value))) return 'Hình thức giảng dạy không hợp lệ.';
  if (check(5) && !['HOUR', 'SESSION'].includes(draft.priceUnit)) return 'Đơn vị học phí không hợp lệ.';
  if (check(4) && (!draft.teachingModes.length || (offline && (!draft.teachingAreas.trim() || !['3', '5', '10', '20'].includes(draft.travelRadius))))) return 'Vui lòng chọn hình thức và khu vực giảng dạy trực tiếp.';
  if (check(5)) for (const price of [draft.teachingModes.includes('ONLINE') ? draft.onlinePrice : '0', offline ? draft.offlinePrice : '0']) if (!/^\d+$/.test(price) || !Number.isSafeInteger(Number(price))) return 'Học phí phải là số không âm, không được để trống.';
  if (check(6)) { const error = validateSchedule(draft.availability); if (error) return error; }
  if (check(7) && (!draft.title.trim() || !draft.bio.trim() || !draft.teachingMethod.trim() || !draft.strengths.trim())) return 'Vui lòng hoàn thiện tiêu đề, giới thiệu, phương pháp và điểm mạnh.';
  if (check(8) && draft.certificates.some(c => !c.name.trim() || !c.issuer.trim() || !c.image || !validDate(c.issuedAt) || c.issuedAt > new Date().toISOString().slice(0, 10) || (c.expiresAt && (!validDate(c.expiresAt) || c.expiresAt < c.issuedAt)))) return 'Vui lòng kiểm tra tên, đơn vị cấp, ngày và ảnh chứng chỉ.';
  if (check(9) && (!verification.front || !verification.back || !verification.portrait)) return 'Vui lòng thêm CCCD hai mặt và ảnh chân dung để xác minh.';
  return null;
};
