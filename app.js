// ==========================================================================
// Firebase & LocalStorage Fallback Initialization
// ==========================================================================
let db = null;
let auth = null;
let currentUser = null;
let isGuestMode = false;

// Firebase configuration (using existing credentials or fallback to guest local-only)
const firebaseConfig = {
    apiKey: "AIzaSyC8bfzol0oGji86823dr8h2r4CIQjfbR0U",
    authDomain: "whatiate-7d5ba.firebaseapp.com",
    projectId: "whatiate-7d5ba",
    storageBucket: "whatiate-7d5ba.firebasestorage.app",
    messagingSenderId: "465598882926",
    appId: "1:465598882926:web:95c9343182a457178bf27f",
    measurementId: "G-2V65GWTWRE"
};

try {
    // Attempt Firebase initialization
    if (typeof firebase !== 'undefined') {
        firebase.initializeApp(firebaseConfig);
        db = firebase.firestore();
        auth = firebase.auth();
    } else {
        console.warn("Firebase SDK not loaded. Defaulting to LocalStorage Mode.");
        isGuestMode = true;
    }
} catch (error) {
    console.error("Firebase init failed, switching to LocalStorage Mode:", error);
    isGuestMode = true;
}

// ==========================================================================
// Application State
// ==========================================================================
let currentTab = 'timeline';
let timelineViewMode = 'list'; // 'list' or 'grid'
let likesViewMode = 'list';
let currentYear = new Date().getFullYear();
let currentMonth = new Date().getMonth(); // 0-indexed

// Local memory cache for recipes and schedules
let cachedRecipes = [];
let cachedSchedules = [];
let drawnSessionIds = new Set(); // Excludes already drawn recipe IDs in Gacha session

// Default guest profile
const DEFAULT_AVATAR = "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=120&h=120";
let guestProfile = {
    uid: "guest-user-123",
    displayName: "ゲストシェフ 🍳",
    photoURL: DEFAULT_AVATAR
};

// ==========================================================================
// YouTube Parser Helpers
// ==========================================================================
function getYouTubeId(url) {
    if (!url) return null;
    // Trim spaces
    url = url.trim();
    // Check if it's already an 11-character video ID
    if (url.length === 11 && !url.includes('/') && !url.includes('.')) {
        return url;
    }
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=|shorts\/)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function getYouTubeThumbnail(videoId) {
    if (!videoId) return '';
    // Use maximum resolution default thumbnail (16:9 high res)
    return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
}

function isShortsVideo(url) {
    if (!url) return false;
    return url.toLowerCase().includes('/shorts/');
}

// ==========================================================================
// LocalStorage Database Operations (Guest Mode Fallback)
// ==========================================================================
function getLocalData(key, defaultValue = []) {
    try {
        const data = localStorage.getItem(key);
        return data ? JSON.parse(data) : defaultValue;
    } catch (e) {
        console.error("LocalStorage read error", e);
        return defaultValue;
    }
}

function setLocalData(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        console.error("LocalStorage write error", e);
    }
}

// ==========================================================================
// Database & Auth Controller
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
    initAuth();
    initEventListeners();
    switchTab('timeline'); // Default active tab
});

function initAuth() {
    if (isGuestMode || !auth) {
        setupGuestSession();
        return;
    }

    // Monitor Firebase Auth state
    auth.onAuthStateChanged(user => {
        if (user) {
            currentUser = user;
            isGuestMode = false;
            document.getElementById('headerLoginBtn').style.display = 'none';
            
            const userProfileHeader = document.getElementById('userProfileHeader');
            document.getElementById('userHeaderAvatar').src = user.photoURL || DEFAULT_AVATAR;
            document.getElementById('userHeaderName').innerText = user.displayName || "o";
            userProfileHeader.style.display = 'flex';
            
            loadData();
        } else {
            // Check if user has selected guest session fallback
            const hasChosenGuest = localStorage.getItem('chosenGuestSession') === 'true';
            if (hasChosenGuest) {
                setupGuestSession();
            } else {
                // Show login overlay
                document.getElementById('loginOverlay').style.display = 'flex';
            }
        }
    });

    // Google Login Handler
    document.getElementById('googleLoginBtn').addEventListener('click', () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        auth.signInWithPopup(provider)
            .then(() => {
                document.getElementById('loginOverlay').style.display = 'none';
                localStorage.setItem('chosenGuestSession', 'false');
            })
            .catch(error => {
                console.error("Google sign-in error:", error);
                alert("ログインに失敗しました。時間をおいて再度お試しください。");
            });
    });

    // Guest Mode login Handler
    document.getElementById('guestLoginBtn').addEventListener('click', () => {
        setupGuestSession();
        document.getElementById('loginOverlay').style.display = 'none';
    });

    // Header profile logout click
    document.getElementById('userProfileHeader').addEventListener('click', () => {
        if (confirm("ログアウトしますか？")) {
            if (auth) {
                auth.signOut().then(() => {
                    localStorage.removeItem('chosenGuestSession');
                    location.reload();
                });
            } else {
                localStorage.removeItem('chosenGuestSession');
                location.reload();
            }
        }
    });
}

function setupGuestSession() {
    currentUser = guestProfile;
    isGuestMode = true;
    localStorage.setItem('chosenGuestSession', 'true');
    
    document.getElementById('headerLoginBtn').style.display = 'none';
    const userProfileHeader = document.getElementById('userProfileHeader');
    document.getElementById('userHeaderAvatar').src = guestProfile.photoURL;
    document.getElementById('userHeaderName').innerText = guestProfile.displayName;
    userProfileHeader.style.display = 'flex';
    
    loadData();
}

// Load data either from Firestore or LocalStorage
function loadData() {
    if (db) {
        // Run migration from legacy 'shared_gacha_recipes' document if present (only if not guest mode)
        if (!isGuestMode && currentUser && currentUser.uid !== guestProfile.uid) {
            db.collection('meals').doc('shared_gacha_recipes').get()
                .then(doc => {
                    if (doc.exists) {
                        const data = doc.data();
                        const legacyRecipes = data.recipes || [];
                        if (legacyRecipes.length > 0) {
                            console.log("Migrating legacy recipes count:", legacyRecipes.length);
                            
                            db.collection('meals').get().then(snap => {
                                const existingVideoIds = new Set();
                                snap.forEach(d => {
                                    if (d.id !== 'shared_gacha_recipes' && d.data().videoId) {
                                        existingVideoIds.add(d.data().videoId);
                                    }
                                });
                                
                                const promises = [];
                                legacyRecipes.forEach(legacy => {
                                    if (!existingVideoIds.has(legacy.id)) {
                                        const mappedRecipe = {
                                            youtubeUrl: `https://www.youtube.com/watch?v=${legacy.id}`,
                                            videoId: legacy.id,
                                            dishName: legacy.title || '無題のレシピ',
                                            channelName: legacy.creator || 'YouTube',
                                            style: legacy.style || '自炊',
                                            mealTime: 'dinner',
                                            genre: 'その他',
                                            taste: legacy.taste || 'その他',
                                            ingredient: legacy.ingredients && legacy.ingredients.length > 0 ? legacy.ingredients[0] : 'その他',
                                            focus: legacy.focus || 'その他',
                                            review: '以前登録されたレシピ動画',
                                            likesCount: 0,
                                            likedUsers: [],
                                            createdBy: currentUser.uid,
                                            createdByName: currentUser.displayName || 'o',
                                            avatarUrl: currentUser.photoURL || DEFAULT_AVATAR,
                                            createdAt: new Date().toISOString()
                                        };
                                        promises.push(db.collection('meals').add(mappedRecipe));
                                    }
                                });
                                
                                Promise.all(promises).then(() => {
                                    db.collection('meals').doc('shared_gacha_recipes').delete()
                                        .then(() => console.log("Legacy recipe migration completed successfully."));
                                });
                            });
                        } else {
                            db.collection('meals').doc('shared_gacha_recipes').delete();
                        }
                    }
                }).catch(err => {
                    console.error("Migration check failed:", err);
                });
        }

        // Stream shared recipes from Firestore for EVERYONE (Guests and Logged in users!)
        db.collection('meals').orderBy('createdAt', 'desc')
            .onSnapshot(snapshot => {
                // Filter out the legacy migration document from rendering list
                cachedRecipes = snapshot.docs
                    .map(doc => ({ id: doc.id, ...doc.data() }))
                    .filter(r => r.id !== 'shared_gacha_recipes');
                renderFeed();
                updateRegisteredRecipesList();
            }, error => {
                console.error("Firestore meals stream error:", error);
                loadLocalRecipes();
            });
    } else {
        loadLocalRecipes();
    }

    // Load calendar schedules
    if (db && currentUser && currentUser.uid !== guestProfile.uid && !isGuestMode) {
        db.collection('meal_schedules').where('createdBy', '==', currentUser.uid)
            .onSnapshot(snapshot => {
                cachedSchedules = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
                renderCalendar();
            }, error => {
                console.error("Firestore schedules stream error:", error);
            });
    } else {
        cachedSchedules = getLocalData('what_i_ate_schedules', []);
        renderCalendar();
    }
}

function loadLocalRecipes() {
    cachedRecipes = getLocalData('what_i_ate_recipes', []);
    renderFeed();
    updateRegisteredRecipesList();
}

// ==========================================================================
// UI Tab Switcher
// ==========================================================================
function switchTab(tabId) {
    currentTab = tabId;
    
    // Update active state in panel views
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });
    const activePanel = document.getElementById(`tab-${tabId}`);
    if (activePanel) activePanel.classList.add('active');

    // Update active tab styling on Desktop Nav
    document.querySelectorAll('.app-nav .nav-tab').forEach(tab => {
        if (tab.dataset.tab === tabId) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // Update active tab styling on Mobile Bottom Nav
    document.querySelectorAll('.bottom-nav-bar .bottom-nav-item').forEach(item => {
        if (item.dataset.tab === tabId) {
            item.classList.add('active');
        } else {
            item.classList.remove('active');
        }
    });

    // Refresh rendering depending on tab
    if (tabId === 'timeline') {
        renderFeed();
    } else if (tabId === 'calendar') {
        renderCalendar();
    } else if (tabId === 'likes') {
        renderFeed();
    } else if (tabId === 'gacha') {
        resetGachaScreen();
        updateRegisteredRecipesList();
    }
}

// ==========================================================================
// Event Listeners Registration
// ==========================================================================
function initEventListeners() {
    // Navigation Tabs Event Listeners (Desktop)
    document.querySelectorAll('.app-nav .nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Navigation Tabs Event Listeners (Mobile Bottom)
    document.querySelectorAll('.bottom-nav-bar .bottom-nav-item').forEach(item => {
        if (item.dataset.tab) {
            item.addEventListener('click', () => switchTab(item.dataset.tab));
        }
    });

    // Bottom Navigation central Upload "+" button trigger
    const bottomNavUploadBtn = document.getElementById('bottomNavUploadBtn');
    if (bottomNavUploadBtn) {
        bottomNavUploadBtn.addEventListener('click', () => {
            document.getElementById('addMealModal').classList.add('active');
        });
    }

    // Modal close buttons
    document.querySelectorAll('.modal-overlay .close-btn, .btn-secondary').forEach(btn => {
        btn.addEventListener('click', (e) => {
            // Close all overlays
            document.querySelectorAll('.modal-overlay').forEach(modal => {
                if (modal.id !== 'loginOverlay') {
                    modal.classList.remove('active');
                }
            });
            // Stop YouTube player inside player iframe if active
            const iframeContainer = document.getElementById('youtubeIframeContainer');
            if (iframeContainer) iframeContainer.innerHTML = '';
        });
    });

    // Collapsible Filter Dashboard toggle
    const timelineFilterToggleBtn = document.getElementById('timelineFilterToggleBtn');
    const timelineFilterDashboard = document.getElementById('timelineFilterDashboard');
    if (timelineFilterToggleBtn && timelineFilterDashboard) {
        timelineFilterToggleBtn.addEventListener('click', () => {
            timelineFilterDashboard.classList.toggle('collapsed');
            timelineFilterToggleBtn.classList.toggle('active');
        });
    }

    // Feed / Grid Toggles (Timeline)
    document.getElementById('timelineListViewBtn').addEventListener('click', () => {
        document.getElementById('timelineListViewBtn').classList.add('active');
        document.getElementById('timelineGridViewBtn').classList.remove('active');
        timelineViewMode = 'list';
        renderFeed();
    });

    document.getElementById('timelineGridViewBtn').addEventListener('click', () => {
        document.getElementById('timelineGridViewBtn').classList.add('active');
        document.getElementById('timelineListViewBtn').classList.remove('active');
        timelineViewMode = 'grid';
        renderFeed();
    });

    // Feed / Grid Toggles (Likes)
    document.getElementById('likesListViewBtn').addEventListener('click', () => {
        document.getElementById('likesListViewBtn').classList.add('active');
        document.getElementById('likesGridViewBtn').classList.remove('active');
        likesViewMode = 'list';
        renderFeed();
    });

    document.getElementById('likesGridViewBtn').addEventListener('click', () => {
        document.getElementById('likesGridViewBtn').classList.add('active');
        document.getElementById('likesListViewBtn').classList.remove('active');
        likesViewMode = 'grid';
        renderFeed();
    });

    // Timeline Filter events
    document.querySelectorAll('#timelineMealTypeFilters .filter-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('#timelineMealTypeFilters .filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderFeed();
        });
    });

    ['filterStyle', 'filterGenre', 'filterTaste', 'filterIngredient', 'filterFocus', 'filterSort'].forEach(id => {
        document.getElementById(id).addEventListener('change', () => renderFeed());
    });

    // Add recipe submit form handler
    document.getElementById('addMealForm').addEventListener('submit', handleAddRecipeSubmit);

    // Gacha Lever pulling logic
    const gachaLever = document.getElementById('gachaLever');
    if (gachaLever) {
        gachaLever.addEventListener('click', triggerGachaSpin);
    }
    const gachaRetryBtn = document.getElementById('gachaRetryBtn');
    if (gachaRetryBtn) {
        gachaRetryBtn.addEventListener('click', triggerGachaSpin);
    }

    // Accordion expand logic
    const accordionHeader = document.getElementById('accordionHeader');
    const gachaManagerAccordion = document.getElementById('gachaManagerAccordion');
    if (accordionHeader && gachaManagerAccordion) {
        accordionHeader.addEventListener('click', () => {
            gachaManagerAccordion.classList.toggle('open');
        });
    }

    // Modal Close Cancellation buttons
    const cancelAddMealBtn = document.getElementById('cancelAddMealBtn');
    if (cancelAddMealBtn) {
        cancelAddMealBtn.addEventListener('click', () => {
            document.getElementById('addMealModal').classList.remove('active');
        });
    }

    // Calendar Navigation buttons
    document.getElementById('prevMonthBtn').addEventListener('click', () => {
        currentMonth--;
        if (currentMonth < 0) {
            currentMonth = 11;
            currentYear--;
        }
        renderCalendar();
    });

    document.getElementById('nextMonthBtn').addEventListener('click', () => {
        currentMonth++;
        if (currentMonth > 11) {
            currentMonth = 0;
            currentYear++;
        }
        renderCalendar();
    });
}

// ==========================================================================
// Recipe Submission Controller
// ==========================================================================
function handleAddRecipeSubmit(e) {
    e.preventDefault();

    // Check if Guest Mode
    if (db && (isGuestMode || currentUser.uid === guestProfile.uid)) {
        document.getElementById('addMealModal').classList.remove('active');
        document.getElementById('loginOverlay').style.display = 'flex';
        return;
    }

    const recipeUrl = document.getElementById('recipeUrl').value.trim();
    const recipeTitle = document.getElementById('recipeTitle').value.trim();
    const recipeChannel = document.getElementById('recipeChannel').value.trim();
    const recipeStyle = document.getElementById('recipeStyle').value;
    const recipeMealTime = document.getElementById('recipeMealTime').value;
    const recipeGenre = document.getElementById('recipeGenre').value;
    const recipeTaste = document.getElementById('recipeTaste').value;
    const recipeIngredient = document.getElementById('recipeIngredient').value;
    const recipeFocus = document.getElementById('recipeFocus').value;
    const recipeReview = document.getElementById('recipeReview').value.trim();

    const videoId = getYouTubeId(recipeUrl);
    if (!videoId) {
        alert("有効なYouTube動画URLまたは動画IDを入力してください。");
        return;
    }

    const newRecipe = {
        youtubeUrl: recipeUrl,
        videoId: videoId,
        dishName: recipeTitle,
        channelName: recipeChannel,
        style: recipeStyle,
        mealTime: recipeMealTime,
        genre: recipeGenre,
        taste: recipeTaste,
        ingredient: recipeIngredient,
        focus: recipeFocus,
        review: recipeReview,
        likesCount: 0,
        likedUsers: [],
        createdBy: currentUser.uid,
        createdByName: currentUser.displayName,
        avatarUrl: currentUser.photoURL || DEFAULT_AVATAR,
        createdAt: new Date().toISOString()
    };

    if (isGuestMode || !db) {
        // Save to LocalStorage
        newRecipe.id = 'recipe_' + Date.now();
        cachedRecipes.unshift(newRecipe);
        setLocalData('what_i_ate_recipes', cachedRecipes);
        
        completeSubmission();
    } else {
        // Save to Firestore
        db.collection('meals').add(newRecipe)
            .then(() => {
                completeSubmission();
            })
            .catch(error => {
                console.error("Firestore save error:", error);
                alert("登録に失敗しました。");
            });
    }

    function completeSubmission() {
        document.getElementById('addMealForm').reset();
        document.getElementById('addMealModal').classList.remove('active');
        renderFeed();
        updateRegisteredRecipesList();
    }
}

// ==========================================================================
// Timeline / Feed Rendering Engine
// ==========================================================================
function getFilteredRecipes() {
    let list = [...cachedRecipes];

    if (currentTab === 'likes') {
        list = list.filter(r => r.likedUsers && r.likedUsers.includes(currentUser.uid));
    }

    // Filter 1: Meal Type (すべて/朝食/昼食/夕食/おやつ)
    const activeMealTypeBtn = document.querySelector('#timelineMealTypeFilters .filter-btn.active');
    if (activeMealTypeBtn) {
        const mealTimeFilter = activeMealTypeBtn.dataset.filter;
        if (mealTimeFilter !== 'all') {
            list = list.filter(r => r.mealTime === mealTimeFilter);
        }
    }

    // Filter 2: Style (自炊/外食/中食)
    const styleFilter = document.getElementById('filterStyle').value;
    if (styleFilter !== 'all') {
        list = list.filter(r => r.style === styleFilter);
    }

    // Filter 3: Genre (和風/洋風/中華など)
    const genreFilter = document.getElementById('filterGenre').value;
    if (genreFilter !== 'all') {
        list = list.filter(r => r.genre === genreFilter);
    }

    // Filter 4: Taste (あっさり/こってり等)
    const tasteFilter = document.getElementById('filterTaste').value;
    if (tasteFilter !== 'all') {
        list = list.filter(r => r.taste === tasteFilter);
    }

    // Filter 5: Ingredient (肉類/魚介類等)
    const ingredientFilter = document.getElementById('filterIngredient').value;
    if (ingredientFilter !== 'all') {
        list = list.filter(r => r.ingredient === ingredientFilter);
    }

    // Filter 6: Focus (時短/節約等)
    const focusFilter = document.getElementById('filterFocus').value;
    if (focusFilter !== 'all') {
        list = list.filter(r => r.focus === focusFilter);
    }

    // Sorting
    const sortVal = document.getElementById('filterSort').value;
    if (sortVal === 'newest') {
        list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    } else if (sortVal === 'likes') {
        list.sort((a, b) => (b.likesCount || 0) - (a.likesCount || 0));
    }

    return list;
}

function renderFeed() {
    const list = getFilteredRecipes();

    // Map targets depending on active Tab
    const isLikesTab = (currentTab === 'likes');
    const feedContainer = document.getElementById(isLikesTab ? 'likesFeed' : 'timelineFeed');
    const gridContainer = document.getElementById(isLikesTab ? 'likesGrid' : 'timelineGrid');
    const activeViewMode = isLikesTab ? likesViewMode : timelineViewMode;

    feedContainer.innerHTML = '';
    gridContainer.innerHTML = '';

    if (list.length === 0) {
        const emptyState = `
            <div class="feed-empty-state">
                <div class="empty-state-emoji">🍳</div>
                <h3>レシピ動画がありません</h3>
                <p>${isLikesTab ? 'お気に入りに登録された料理動画がありません。フィードから「美味しそう！」を押して登録してみましょう。' : 'まだレシピ動画が登録されていません。下部の「＋」ボタンからおすすめの料理動画を登録してください！'}</p>
            </div>
        `;
        feedContainer.innerHTML = emptyState;
        gridContainer.style.display = 'none';
        feedContainer.style.display = 'flex';
        return;
    }

    if (activeViewMode === 'list') {
        gridContainer.style.display = 'none';
        feedContainer.style.display = 'flex';

        list.forEach(recipe => {
            const hasLiked = recipe.likedUsers && recipe.likedUsers.includes(currentUser.uid);
            const dateStr = formatPostDate(recipe.createdAt);
            const card = document.createElement('div');
            card.className = 'post-card';
            card.innerHTML = `
                <div class="post-header">
                    <div class="post-user-info">
                        <img src="${recipe.avatarUrl || DEFAULT_AVATAR}" alt="Avatar" class="post-avatar-img">
                        <div>
                            <div class="post-username">${recipe.createdByName || 'o'}</div>
                            <div class="post-time">${dateStr}</div>
                        </div>
                    </div>
                    <div class="post-actions-right">
                        ${recipe.createdBy === currentUser.uid ? `
                            <button class="post-menu-btn delete-btn" data-id="${recipe.id}" title="削除">🗑️</button>
                        ` : ''}
                    </div>
                </div>
                
                <div class="post-img-container" data-id="${recipe.id}">
                    <img src="${getYouTubeThumbnail(recipe.videoId)}" alt="${recipe.dishName}" class="post-img" onerror="this.onerror=null; this.src='https://img.youtube.com/vi/${recipe.videoId}/hqdefault.jpg';">
                    <div class="play-btn-overlay">▶</div>
                    ${isShortsVideo(recipe.youtubeUrl) ? `<div class="grid-video-badge">Shorts</div>` : ''}
                </div>

                <div class="post-body">
                    <h3 class="post-video-title">${recipe.dishName}</h3>
                    <div class="post-channel-name">${recipe.channelName}</div>

                    <div class="post-tags-container">
                        <span class="post-tag-badge style">#${recipe.style}</span>
                        <span class="post-tag-badge genre">#${recipe.genre}</span>
                        <span class="post-tag-badge taste">#${recipe.taste}</span>
                        <span class="post-tag-badge ingredient">#${recipe.ingredient}</span>
                        ${recipe.focus !== 'その他' ? `<span class="post-tag-badge focus">#${recipe.focus}</span>` : ''}
                    </div>

                    <div class="post-interactive-row">
                        <button class="like-action-btn ${hasLiked ? 'liked' : ''}" data-id="${recipe.id}">
                            <span class="like-icon">🤤</span> 美味しそう！ (<span class="like-counter">${recipe.likesCount || 0}</span>)
                        </button>
                    </div>

                    ${recipe.review ? `
                        <div class="post-comment">
                            <span class="caption-user">${recipe.createdByName || 'o'}</span>${recipe.review}
                        </div>
                    ` : ''}
                </div>
            `;

            // Setup listeners
            card.querySelector('.post-img-container').addEventListener('click', () => openVideoDetailModal(recipe.id));
            card.querySelector('.like-action-btn').addEventListener('click', () => toggleLikeRecipe(recipe.id));
            
            const deleteBtn = card.querySelector('.delete-btn');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', () => deleteRecipe(recipe.id));
            }

            feedContainer.appendChild(card);
        });
    } else {
        feedContainer.style.display = 'none';
        gridContainer.style.display = 'grid';

        list.forEach(recipe => {
            const gridItem = document.createElement('div');
            gridItem.className = 'grid-post-item';
            gridItem.innerHTML = `
                <img src="${getYouTubeThumbnail(recipe.videoId)}" alt="${recipe.dishName}" class="grid-post-img" onerror="this.onerror=null; this.src='https://img.youtube.com/vi/${recipe.videoId}/hqdefault.jpg';">
                <div class="grid-post-overlay">
                    <div class="grid-overlay-item">🤤 ${recipe.likesCount || 0}</div>
                </div>
                ${isShortsVideo(recipe.youtubeUrl) ? `<div class="grid-video-badge">Shorts</div>` : ''}
            `;
            gridItem.addEventListener('click', () => openVideoDetailModal(recipe.id));
            gridContainer.appendChild(gridItem);
        });
    }
}

function formatPostDate(isoStr) {
    if (!isoStr) return '';
    const date = new Date(isoStr);
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHr / 24);

    if (diffMin < 1) return '今さっき';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHr < 24) return `${diffHr}時間前`;
    if (diffDay === 1) return '昨日';
    if (diffDay < 7) return `${diffDay}日前`;
    
    // Default calendar dates format
    return `${date.getMonth() + 1}月${date.getDate()}日`;
}

// ==========================================================================
// Recipe Rating & Interaction (Like / Delete)
// ==========================================================================
function toggleLikeRecipe(recipeId) {
    if (db && (isGuestMode || currentUser.uid === guestProfile.uid)) {
        // Close modal if open
        document.getElementById('youtubePlayerModal').classList.remove('active');
        const iframeContainer = document.getElementById('youtubeIframeContainer');
        if (iframeContainer) iframeContainer.innerHTML = '';
        
        document.getElementById('loginOverlay').style.display = 'flex';
        return;
    }

    const idx = cachedRecipes.findIndex(r => r.id === recipeId);
    if (idx === -1) return;

    let recipe = cachedRecipes[idx];
    if (!recipe.likedUsers) recipe.likedUsers = [];

    const userLikeIndex = recipe.likedUsers.indexOf(currentUser.uid);
    if (userLikeIndex > -1) {
        // Unlike
        recipe.likedUsers.splice(userLikeIndex, 1);
    } else {
        // Like
        recipe.likedUsers.push(currentUser.uid);
    }
    recipe.likesCount = recipe.likedUsers.length;

    if (isGuestMode || !db) {
        cachedRecipes[idx] = recipe;
        setLocalData('what_i_ate_recipes', cachedRecipes);
        renderFeed();
        // If modal player is currently open, sync it
        updateModalLikeState(recipe);
    } else {
        db.collection('meals').doc(recipeId).update({
            likedUsers: recipe.likedUsers,
            likesCount: recipe.likesCount
        }).then(() => {
            updateModalLikeState(recipe);
        });
    }
}

function updateModalLikeState(recipe) {
    const modal = document.getElementById('youtubePlayerModal');
    if (modal.classList.contains('active')) {
        const detailLikeBtn = document.getElementById('detailLikeBtn');
        const detailLikeCount = document.getElementById('detailLikeCount');
        
        const hasLiked = recipe.likedUsers.includes(currentUser.uid);
        if (hasLiked) {
            detailLikeBtn.classList.add('liked');
        } else {
            detailLikeBtn.classList.remove('liked');
        }
        detailLikeCount.innerText = recipe.likesCount || 0;
    }
}

function deleteRecipe(recipeId) {
    if (!confirm("このおすすめレシピ動画を削除しますか？")) return;

    if (isGuestMode || !db) {
        cachedRecipes = cachedRecipes.filter(r => r.id !== recipeId);
        // Also wipe any schedule calendar instances tied to this recipeId
        cachedSchedules = cachedSchedules.filter(s => s.mealId !== recipeId);
        
        setLocalData('what_i_ate_recipes', cachedRecipes);
        setLocalData('what_i_ate_schedules', cachedSchedules);
        
        renderFeed();
        renderCalendar();
        updateRegisteredRecipesList();
    } else {
        db.collection('meals').doc(recipeId).delete()
            .then(() => {
                // Delete associated schedules
                db.collection('meal_schedules').where('mealId', '==', recipeId).get()
                    .then(snap => {
                        snap.forEach(doc => doc.ref.delete());
                    });
            })
            .catch(err => console.error("Error deleting document:", err));
    }
}

// ==========================================================================
// Embedded Video Player Modal Controller
// ==========================================================================
function openVideoDetailModal(recipeId) {
    const recipe = cachedRecipes.find(r => r.id === recipeId);
    if (!recipe) return;

    // Set player markup
    const iframeContainer = document.getElementById('youtubeIframeContainer');
    const isShorts = isShortsVideo(recipe.youtubeUrl);
    
    if (isShorts) {
        iframeContainer.className = "youtube-player-wrapper shorts-mode";
        iframeContainer.innerHTML = `
            <iframe src="https://www.youtube.com/embed/${recipe.videoId}?autoplay=1&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
        `;
    } else {
        iframeContainer.className = "youtube-player-wrapper";
        iframeContainer.innerHTML = `
            <iframe src="https://www.youtube.com/embed/${recipe.videoId}?autoplay=1&rel=0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
        `;
    }

    // Set details text
    document.getElementById('detailVideoTitle').innerText = recipe.dishName;
    document.getElementById('detailChannelName').innerText = recipe.channelName;
    document.getElementById('detailUserName').innerText = recipe.createdByName || 'o';
    document.getElementById('detailUserReview').innerText = recipe.review || '特になし';

    // Tags list
    const tagsContainer = document.getElementById('detailTagsContainer');
    tagsContainer.innerHTML = `
        <span class="post-tag-badge style">#${recipe.style}</span>
        <span class="post-tag-badge genre">#${recipe.genre}</span>
        <span class="post-tag-badge taste">#${recipe.taste}</span>
        <span class="post-tag-badge ingredient">#${recipe.ingredient}</span>
        ${recipe.focus !== 'その他' ? `<span class="post-tag-badge focus">#${recipe.focus}</span>` : ''}
    `;

    // Like button state
    const detailLikeBtn = document.getElementById('detailLikeBtn');
    const hasLiked = recipe.likedUsers && recipe.likedUsers.includes(currentUser.uid);
    if (hasLiked) {
        detailLikeBtn.classList.add('liked');
    } else {
        detailLikeBtn.classList.remove('liked');
    }
    document.getElementById('detailLikeCount').innerText = recipe.likesCount || 0;

    // Remove old listeners
    const newLikeBtn = detailLikeBtn.cloneNode(true);
    detailLikeBtn.parentNode.replaceChild(newLikeBtn, detailLikeBtn);
    newLikeBtn.addEventListener('click', () => toggleLikeRecipe(recipe.id));

    // Calendar add schedule action
    const detailScheduleBtn = document.getElementById('detailScheduleBtn');
    const newScheduleBtn = detailScheduleBtn.cloneNode(true);
    detailScheduleBtn.parentNode.replaceChild(newScheduleBtn, detailScheduleBtn);
    newScheduleBtn.addEventListener('click', () => {
        openCalendarDateSelectModal(recipe.id);
    });

    document.getElementById('youtubePlayerModal').classList.add('active');
}

// ==========================================================================
// Date Picker Modal (For calendar scheduling)
// ==========================================================================
function openCalendarDateSelectModal(recipeId) {
    const modal = document.getElementById('calendarDateSelectModal');
    // Set default today in local timezone
    const todayStr = new Date().toISOString().split('T')[0];
    document.getElementById('calendarTargetDate').value = todayStr;

    modal.classList.add('active');

    // Handle confirms
    const confirmBtn = document.getElementById('confirmDateSelectBtn');
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    newConfirmBtn.addEventListener('click', () => {
        const targetDate = document.getElementById('calendarTargetDate').value;
        if (!targetDate) {
            alert("日付を選択してください。");
            return;
        }

        const newSchedule = {
            date: targetDate,
            mealId: recipeId,
            createdBy: currentUser.uid,
            createdAt: new Date().toISOString()
        };

        if (isGuestMode || !db) {
            newSchedule.id = 'schedule_' + Date.now();
            cachedSchedules.push(newSchedule);
            setLocalData('what_i_ate_schedules', cachedSchedules);
            
            completeScheduleAdd();
        } else {
            db.collection('meal_schedules').add(newSchedule)
                .then(() => {
                    completeScheduleAdd();
                })
                .catch(err => {
                    console.error("Firestore schedule add error:", err);
                    alert("カレンダーへの追加に失敗しました。");
                });
        }
    });

    function completeScheduleAdd() {
        modal.classList.remove('active');
        alert("カレンダーに登録しました！📅");
        renderCalendar();
    }
}

// ==========================================================================
// Meal Calendar Rendering Engine
// ==========================================================================
function renderCalendar() {
    const daysContainer = document.getElementById('calendarDays');
    if (!daysContainer) return;

    daysContainer.innerHTML = '';
    
    // Set Month Year title
    document.getElementById('calendarMonthTitle').innerText = `${currentYear}年 ${currentMonth + 1}月`;

    const firstDayIndex = new Date(currentYear, currentMonth, 1).getDay();
    const lastDayDate = new Date(currentYear, currentMonth + 1, 0).getDate();

    // Fill preceding empty boxes
    for (let i = 0; i < firstDayIndex; i++) {
        const emptyCell = document.createElement('div');
        emptyCell.className = 'calendar-day empty';
        daysContainer.appendChild(emptyCell);
    }

    const today = new Date();

    // Render calendar dates
    for (let day = 1; day <= lastDayDate; day++) {
        const dayCell = document.createElement('div');
        dayCell.className = 'calendar-day';
        
        const dateStr = `${currentYear}-${String(currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        
        // Highlight today
        if (day === today.getDate() && currentMonth === today.getMonth() && currentYear === today.getFullYear()) {
            dayCell.classList.add('today');
        }

        dayCell.innerHTML = `<span class="day-number">${day}</span>`;

        // Check if there are scheduled recipe videos for this date
        const dayMeals = cachedSchedules.filter(s => s.date === dateStr);
        if (dayMeals.length > 0) {
            // Find corresponding recipe data
            const firstMealId = dayMeals[0].mealId;
            const recipe = cachedRecipes.find(r => r.id === firstMealId);
            
            if (recipe) {
                const thumb = document.createElement('div');
                thumb.className = 'day-meal-thumbnail';
                thumb.innerHTML = `
                    <img src="${getYouTubeThumbnail(recipe.videoId)}" alt="${recipe.dishName}" onerror="this.onerror=null; this.src='https://img.youtube.com/vi/${recipe.videoId}/hqdefault.jpg';">
                    ${dayMeals.length > 1 ? `<div class="day-meal-count-badge">${dayMeals.length}</div>` : ''}
                `;
                dayCell.appendChild(thumb);
            }
        }

        // Click day event handler
        dayCell.addEventListener('click', () => openDaySchedulePopover(dateStr));
        daysContainer.appendChild(dayCell);
    }
}

function openDaySchedulePopover(dateStr) {
    const popoverList = document.getElementById('schedulePopoverList');
    popoverList.innerHTML = '';
    
    // Format title date
    const dateObj = new Date(dateStr);
    document.getElementById('schedulePopoverTitle').innerText = `${dateObj.getMonth() + 1}月${dateObj.getDate()}日の献立予定`;

    const dayMeals = cachedSchedules.filter(s => s.date === dateStr);
    
    if (dayMeals.length === 0) {
        popoverList.innerHTML = `<p style="font-size: 11px; text-align: center; color: var(--text-light); padding: 12px 0;">献立の予定が入っていません。</p>`;
    } else {
        dayMeals.forEach(schedule => {
            const recipe = cachedRecipes.find(r => r.id === schedule.mealId);
            if (recipe) {
                const item = document.createElement('div');
                item.className = 'schedule-popover-item';
                item.innerHTML = `
                    <img src="${getYouTubeThumbnail(recipe.videoId)}" class="schedule-popover-img" alt="${recipe.dishName}" onerror="this.onerror=null; this.src='https://img.youtube.com/vi/${recipe.videoId}/hqdefault.jpg';">
                    <div class="schedule-popover-info">
                        <div class="schedule-popover-title">${recipe.dishName}</div>
                        <div class="schedule-popover-channel">${recipe.channelName}</div>
                    </div>
                    <button class="schedule-remove-btn" data-id="${schedule.id}">🗑️</button>
                `;
                
                // Add click listener to show video inside player modal
                item.querySelector('.schedule-popover-info').addEventListener('click', () => {
                    document.getElementById('schedulePopoverModal').classList.remove('active');
                    openVideoDetailModal(recipe.id);
                });

                // Remove schedule item listener
                item.querySelector('.schedule-remove-btn').addEventListener('click', (e) => {
                    e.stopPropagation();
                    removeScheduleItem(schedule.id);
                });

                popoverList.appendChild(item);
            }
        });
    }

    document.getElementById('schedulePopoverModal').classList.add('active');
}

function removeScheduleItem(scheduleId) {
    if (!confirm("このレシピ動画の予定をカレンダーから削除しますか？")) return;

    if (isGuestMode || !db) {
        cachedSchedules = cachedSchedules.filter(s => s.id !== scheduleId);
        setLocalData('what_i_ate_schedules', cachedSchedules);
        
        completeRemove();
    } else {
        db.collection('meal_schedules').doc(scheduleId).delete()
            .then(() => {
                completeRemove();
            })
            .catch(err => console.error("Firestore delete schedule failed:", err));
    }

    function completeRemove() {
        document.getElementById('schedulePopoverModal').classList.remove('active');
        renderCalendar();
    }
}

// ==========================================================================
// Curation Gacha Simulator Engine
// ==========================================================================
function resetGachaScreen() {
    document.getElementById('gachaScreenContent').innerHTML = `<div class="gacha-placeholder">❓</div>`;
    document.getElementById('gachaResultCard').style.display = 'none';
    const iframe = document.getElementById('gachaYoutubeIframe');
    if (iframe) iframe.src = "";
    document.getElementById('gachaLever').classList.remove('pulled');
}

function triggerGachaSpin() {
    const list = cachedRecipes; // Draw from all registered videos
    if (list.length === 0) {
        alert("ガチャに登録されている動画がありません。先にフィードの「＋」ボタンからYouTubeレシピ動画を登録してください！");
        return;
    }

    // Filter out recipes already drawn in this session
    let availableList = list.filter(r => !drawnSessionIds.has(r.id));
    if (availableList.length === 0) {
        // Auto reset session draw history when all are exhausted
        drawnSessionIds.clear();
        availableList = list;
    }

    // Lever animation
    const lever = document.getElementById('gachaLever');
    lever.classList.add('pulled');

    // Visual screen roll effect
    const screen = document.getElementById('gachaScreenContent');
    screen.innerHTML = `
        <div class="rolling">
            <div style="font-size: 32px; padding: 4px;">🍛</div>
            <div style="font-size: 32px; padding: 4px;">🍔</div>
            <div style="font-size: 32px; padding: 4px;">🍜</div>
            <div style="font-size: 32px; padding: 4px;">🍣</div>
            <div style="font-size: 32px; padding: 4px;">🍖</div>
        </div>
    `;

    // Pick random recipe item
    const randomIndex = Math.floor(Math.random() * availableList.length);
    const chosenRecipe = availableList[randomIndex];

    // Mark as drawn in the current session
    drawnSessionIds.add(chosenRecipe.id);

    // Stop roll after 1.4s
    setTimeout(() => {
        // Display circular capsule ball inside Gacha screen (just like the previous version!)
        screen.innerHTML = `
            <img src="${getYouTubeThumbnail(chosenRecipe.videoId)}" alt="${chosenRecipe.dishName}" 
                 style="width: 75px; height: 75px; border-radius: 50%; object-fit: cover; border: 3px solid #FFC045; box-shadow: 0 4px 10px rgba(0,0,0,0.3); animation: popIn 0.3s cubic-bezier(0.16, 1, 0.3, 1);" 
                 onerror="this.onerror=null; this.src='https://img.youtube.com/vi/${chosenRecipe.videoId}/hqdefault.jpg';">
        `;
        
        // Pop result card details
        document.getElementById('gachaResultTitle').innerText = chosenRecipe.dishName;
        
        let creatorText = `「${chosenRecipe.createdByName || 'ゲスト'}」の登録レシピ！`;
        let reviewText = chosenRecipe.review ? `「${chosenRecipe.review}」` : '（紹介メモなし）';
        
        document.getElementById('gachaResultDesc').innerHTML = `
            <div style="font-weight: 700; color: var(--text-main); margin-bottom: 4px;">${creatorText}</div>
            <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">チャンネル: ${chosenRecipe.channelName}</div>
            <div style="font-style: italic; font-size: 11px; color: var(--text-light); margin-top: 6px; padding-left: 8px; border-left: 2px solid var(--border-color);">${reviewText}</div>
        `;
        
        const iframe = document.getElementById('gachaYoutubeIframe');
        if (iframe) {
            iframe.src = `https://www.youtube.com/embed/${chosenRecipe.videoId}`;
        }
        
        const resultCard = document.getElementById('gachaResultCard');
        resultCard.style.display = 'block';

        // Auto scroll down smoothly to result card (matching production!)
        setTimeout(() => {
            resultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 100);

        // Setup actions listeners
        const openVideoBtn = document.getElementById('gachaOpenVideoBtn');
        const newOpenVideoBtn = openVideoBtn.cloneNode(true);
        openVideoBtn.parentNode.replaceChild(newOpenVideoBtn, openVideoBtn);
        newOpenVideoBtn.addEventListener('click', () => {
            openVideoDetailModal(chosenRecipe.id);
        });

        const addToCalendarBtn = document.getElementById('gachaAddToCalendarBtn');
        const newAddToCalendarBtn = addToCalendarBtn.cloneNode(true);
        addToCalendarBtn.parentNode.replaceChild(newAddToCalendarBtn, addToCalendarBtn);
        newAddToCalendarBtn.addEventListener('click', () => {
            openCalendarDateSelectModal(chosenRecipe.id);
        });

        // Reset lever styling state
        lever.classList.remove('pulled');
    }, 1400);
}

// ==========================================================================
// Recipe Manager Accordion List
// ==========================================================================
function updateRegisteredRecipesList() {
    const listContainer = document.getElementById('customRecipesList');
    if (!listContainer) return;

    listContainer.innerHTML = '';
    
    // Update registered count label
    document.getElementById('registeredCount').innerText = cachedRecipes.length;

    if (cachedRecipes.length === 0) {
        listContainer.innerHTML = `<div class="custom-recipe-empty">登録されているレシピ動画がありません。</div>`;
        return;
    }

    cachedRecipes.forEach(recipe => {
        const item = document.createElement('div');
        item.className = 'custom-recipe-item';
        item.innerHTML = `
            <div class="custom-recipe-info">
                <div class="custom-recipe-title">${recipe.dishName}</div>
                <div class="custom-recipe-creator">${recipe.channelName}</div>
            </div>
            <div class="custom-recipe-actions">
                <button class="delete-recipe-btn" data-id="${recipe.id}">削除 🗑️</button>
            </div>
        `;
        
        // Video details open listener
        item.querySelector('.custom-recipe-info').addEventListener('click', () => {
            openVideoDetailModal(recipe.id);
        });

        // Recipe deletion action listener
        item.querySelector('.delete-recipe-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteRecipe(recipe.id);
        });

        listContainer.appendChild(item);
    });
}
