require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

async function testConnection() {
    console.log("Testing connection to Supabase...");
    
    // Try inserting a test campaign to verify database write access
    const { data, error } = await supabase
        .from('campaigns')
        .insert([{ 
            name: 'Test Campaign', 
            selected_methods: ['method_1'] 
        }])
        .select();

    if (error) {
        console.error("❌ Connection Error:", error.message);
    } else {
        console.log("✅ SUCCESS! Database connected and test row created:", data);
    }
}

testConnection();