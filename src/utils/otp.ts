export const generateOTP = (length = 4): string => {
  return Math.floor(Math.pow(10, length - 1) + Math.random() * 9 * Math.pow(10, length - 1)).toString();
};
export const generateIdTag = (prefix = 'VS'): string => {
  return `${prefix}_${Date.now().toString(36).toUpperCase()}_${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
};
export const validateOTP = (otp: string, length = 4): boolean => {
  return new RegExp(`^\\d{${length}}$`).test(otp);
};
