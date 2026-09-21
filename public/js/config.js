// ==== KURYEISTANBUL SİTE AYARLARI ====
// WhatsApp numarasını değiştirmek için SADECE aşağıdaki satırı düzenleyin.
// Format: ülke kodu + numara, boşluk/parantez/tire OLMADAN (örn. Türkiye: 90 5xx xxx xx xx)
const SITE_CONFIG = {
  whatsappNumber: '905466780598', // +90 (546) 678 05 98
  whatsappDefaultMessage: 'Merhaba, KuriyeIstanbul.com üzerinden yazıyorum.'
};

function getWhatsappLink(customMessage) {
  const msg = encodeURIComponent(customMessage || SITE_CONFIG.whatsappDefaultMessage);
  return `https://wa.me/${SITE_CONFIG.whatsappNumber}?text=${msg}`;
}

function injectWhatsappButton() {
  const btn = document.createElement('a');
  btn.href = getWhatsappLink();
  btn.target = '_blank';
  btn.rel = 'noopener';
  btn.className = 'whatsapp-fab';
  btn.setAttribute('aria-label', 'WhatsApp ile iletişime geç');
  btn.innerHTML = `
    <svg viewBox="0 0 32 32" width="28" height="28" fill="#fff">
      <path d="M16.001 3C9.373 3 4 8.373 4 15.001c0 2.386.656 4.62 1.797 6.537L4 29l7.637-1.762A11.94 11.94 0 0 0 16.001 27C22.629 27 28 21.627 28 15.001 28 8.373 22.629 3 16.001 3zm0 21.818c-1.98 0-3.826-.561-5.396-1.532l-.387-.232-4.53 1.045 1.07-4.414-.253-.402A9.77 9.77 0 0 1 5.182 15c0-5.964 4.855-10.818 10.819-10.818S26.818 9.036 26.818 15 21.965 24.818 16.001 24.818zm5.978-8.166c-.328-.164-1.94-.957-2.24-1.067-.301-.109-.52-.164-.739.164-.219.328-.848 1.067-1.04 1.286-.191.219-.383.246-.71.082-.328-.164-1.386-.51-2.64-1.627-.976-.87-1.635-1.945-1.827-2.273-.191-.328-.02-.505.144-.668.148-.147.328-.383.492-.574.164-.192.219-.328.328-.547.109-.219.055-.41-.027-.574-.082-.164-.739-1.782-1.012-2.44-.267-.64-.538-.553-.739-.563-.191-.009-.41-.011-.629-.011-.219 0-.574.082-.875.41-.301.328-1.148 1.122-1.148 2.736 0 1.613 1.176 3.172 1.34 3.391.164.219 2.315 3.535 5.611 4.958.784.339 1.396.542 1.873.694.787.25 1.503.215 2.069.13.631-.094 1.94-.793 2.213-1.558.273-.765.273-1.421.191-1.558-.082-.137-.301-.219-.629-.383z"/>
    </svg>`;
  document.body.appendChild(btn);
}
document.addEventListener('DOMContentLoaded', injectWhatsappButton);
