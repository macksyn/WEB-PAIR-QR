import { Storage } from 'megajs';
import 'dotenv/config';

if (!process.env.MEGA_EMAIL || !process.env.MEGA_PASSWORD) {
    throw new Error('MEGA_EMAIL and MEGA_PASSWORD must be set in environment variables');
}

const auth = {
    email: process.env.MEGA_EMAIL,
    password: process.env.MEGA_PASSWORD,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246'
};

export const upload = async (data, name) => {
    if (typeof data === 'string') data = Buffer.from(data);

    const storage = await new Storage({ ...auth }).ready;
    try {
        const file = await storage.upload({ name, size: data.length }, data).complete;
        const url = await file.link();
        return url;
    } finally {
        storage.close();
    }
};
