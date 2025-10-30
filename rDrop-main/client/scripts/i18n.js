// Internationalization (i18n) Handler
class I18n {
    constructor() {
        this.currentLang = 'fr'; // Langue par défaut
        this.translations = {};
        this.init();
    }

    async init() {
        // Charger la langue par défaut
        await this.loadLanguage(this.currentLang);
        this.applyTranslations();
        
        // Écouter l'événement display-name pour réappliquer les traductions
        if (typeof Events !== 'undefined') {
            Events.on('display-name', () => {
                setTimeout(() => this.applyTranslations(), 100);
            });
        }
    }

    async loadLanguage(lang) {
        try {
            const response = await fetch(`lang/${lang}.json`);
            this.translations = await response.json();
            this.currentLang = lang;
            return true;
        } catch (error) {
            console.error(`Failed to load language: ${lang}`, error);
            return false;
        }
    }

    async setLanguage(lang) {
        const success = await this.loadLanguage(lang);
        if (success) {
            this.applyTranslations();
            localStorage.setItem('rdrop-lang', lang);
        }
    }

    get(key) {
        const keys = key.split('.');
        let value = this.translations;
        
        for (const k of keys) {
            if (value && typeof value === 'object') {
                value = value[k];
            } else {
                return key; // Retourne la clé si la traduction n'existe pas
            }
        }
        
        return value || key;
    }

    applyTranslations() {
        // Traduire tous les éléments avec data-i18n
        document.querySelectorAll('[data-i18n]').forEach(element => {
            const key = element.getAttribute('data-i18n');
            const translation = this.get(key);
            
            if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                element.placeholder = translation;
            } else {
                element.textContent = translation;
            }
        });

        // Traduire les attributs title
        document.querySelectorAll('[data-i18n-title]').forEach(element => {
            const key = element.getAttribute('data-i18n-title');
            element.title = this.get(key);
        });

        // Traduire les attributs placeholder
        document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
            const key = element.getAttribute('data-i18n-placeholder');
            element.placeholder = this.get(key);
        });

        // Traduire les attributs desktop/mobile pour x-instructions
        const instructions = document.querySelector('x-instructions');
        if (instructions) {
            instructions.setAttribute('desktop', this.get('main.instructions_desktop'));
            instructions.setAttribute('mobile', this.get('main.instructions_mobile'));
        }
    }
}

// Initialiser i18n globalement
const i18n = new I18n();
