require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { ApifyClient } = require('apify-client');

// Initialize Express Server
const app = express();
app.use(cors()); 
app.use(express.json());

// Initialize Supabase & Apify
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const apifyClient = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

// Health Check Route (To verify Render is working later)
app.get('/', (req, res) => {
    res.send("LeadGen Backend is Active and Running!");
});

// The Main Route to trigger a Campaign Run
app.post('/api/run-campaign', async (req, res) => {
    try {
        const { campaignId, locationId, keywords } = req.body;
        console.log(`Starting Apify scrape for campaign: ${campaignId}...`);

        // 1. Trigger Apify Scraper (Example using a standard Instagram scraper)
        // Note: We use a placeholder input here; you will swap 'apify/instagram-scraper' with your specific Actor ID later.
        const run = await apifyClient.actor('apify/instagram-scraper').call({
            search: keywords ? keywords[0] : "business",
            resultsLimit: 20
        });

        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();
        let uniqueInsertedCount = 0;

        // 2. Save Unique Leads to Supabase
        for (const item of items) {
            const username = item.ownerUsername || item.username;
            if (!username) continue;

            // Check for duplicates
            const { data: existingLead } = await supabase
                .from('leads')
                .select('id')
                .eq('username', username)
                .single();

            let leadId;

            if (!existingLead) {
                // Insert new lead
                const { data: newLead } = await supabase
                    .from('leads')
                    .insert([{
                        username: username,
                        profile_url: `https://instagram.com/${username}`,
                        sources_detected: ['method_1']
                    }])
                    .select('id')
                    .single();
                
                if (newLead) {
                    leadId = newLead.id;
                    uniqueInsertedCount++;
                }
            } else {
                leadId = existingLead.id;
            }

            // Link lead to campaign
            if (leadId && campaignId) {
                await supabase.from('campaign_leads').upsert([{
                    campaign_id: campaignId,
                    lead_id: leadId,
                    top_post_url: item.url
                }]);
            }
        }

        res.status(200).json({
            message: "Campaign executed successfully",
            totalRawScraped: items.length,
            uniqueNewLeads: uniqueInsertedCount
        });

    } catch (error) {
        console.error("Scraping Error:", error);
        res.status(500).json({ error: error.message || "Internal Server Error" });
    }
});

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running perfectly on port ${PORT}`));