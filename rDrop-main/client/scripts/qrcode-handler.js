// QR Code Handler
(function() {
    'use strict';

    let qrcodeInstance = null;

    // Get the QR code button and dialog
    const qrcodeBtn = document.getElementById('qrcode-btn');
    const openQrPrimaryBtn = document.getElementById('open-qrcode');
    const qrcodeDialog = document.getElementById('qrcodeDialog');
    const qrcodeContainer = document.getElementById('qrcode');
    const qrcodeUrlDisplay = document.getElementById('qrcode-url');
    const showUrlBtn = document.getElementById('show-url-btn');

    // Function to check if there are peers and hide/show button
    function updateQrButtonVisibility() {
        const peers = document.querySelectorAll('x-peer');
        if (openQrPrimaryBtn) {
            if (peers.length > 0) {
                openQrPrimaryBtn.style.display = 'none';
            } else {
                openQrPrimaryBtn.style.display = 'block';
            }
        }
    }

    // Listen to peer events
    if (typeof Events !== 'undefined') {
        Events.on('peer-joined', () => updateQrButtonVisibility());
        Events.on('peer-left', () => updateQrButtonVisibility());
        Events.on('peers', () => updateQrButtonVisibility());
    }

    // Initial check
    updateQrButtonVisibility();

    // Function to generate QR code
    function generateQRCode() {
        // Get current URL
        const currentUrl = window.location.href;
        
        // Clear previous QR code if exists
        qrcodeContainer.innerHTML = '';
        
        // Hide URL by default
        qrcodeUrlDisplay.style.display = 'none';
        qrcodeUrlDisplay.textContent = currentUrl;
        
        // Reset button text
        if (showUrlBtn) {
            showUrlBtn.textContent = 'Show URL';
        }
        
        // Generate new QR code
        qrcodeInstance = new QRCode(qrcodeContainer, {
            text: currentUrl,
            width: 256,
            height: 256,
            colorDark: "#000000",
            colorLight: "#ffffff",
            correctLevel: QRCode.CorrectLevel.H
        });
    }

    // Handle QR code button click
    function openQrDialog(e) {
        if (e) e.preventDefault();
        generateQRCode();
        qrcodeDialog.setAttribute('show', '');
    }

    if (qrcodeBtn) {
        qrcodeBtn.addEventListener('click', openQrDialog);
    }
    if (openQrPrimaryBtn) {
        openQrPrimaryBtn.addEventListener('click', openQrDialog);
    }

    // Handle Show URL button click
    if (showUrlBtn) {
        showUrlBtn.addEventListener('click', function(e) {
            e.preventDefault();
            
            if (qrcodeUrlDisplay.style.display === 'none') {
                qrcodeUrlDisplay.style.display = 'block';
                showUrlBtn.textContent = 'Hide URL';
            } else {
                qrcodeUrlDisplay.style.display = 'none';
                showUrlBtn.textContent = 'Show URL';
            }
        });
    }

    // Handle dialog close
    const closeButtons = qrcodeDialog.querySelectorAll('[close]');
    closeButtons.forEach(button => {
        button.addEventListener('click', function() {
            qrcodeDialog.removeAttribute('show');
        });
    });

    // Close dialog when clicking outside
    qrcodeDialog.addEventListener('click', function(e) {
        if (e.target === qrcodeDialog || e.target.classList.contains('full')) {
            qrcodeDialog.removeAttribute('show');
        }
    });

})();
