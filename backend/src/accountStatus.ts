export const accountStatus = (data: Record<string, any>) => data.disabled || data.accountStatus === 'locked' ? 'locked' : data.role === 'tutor' ? data.approvalStatus === 'approved' ? 'active' : data.approvalStatus === 'rejected' ? 'rejected' : 'pending' : 'active';

