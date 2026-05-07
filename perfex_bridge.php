<?php
/**
 * Bridge Optimizado y Ultra-Compatible para Perfex CRM
 */
header('Content-Type: application/json; charset=utf-8');
error_reporting(E_ALL); 
ini_set('display_errors', 0); // No mostrar a cliente, pero sí procesar

// 1. Cargar Configuración de Perfex
if (!file_exists(__DIR__ . '/application/config/app-config.php')) {
    die(json_encode(['error' => 'No se encontró app-config.php']));
}
require_once(__DIR__ . '/application/config/app-config.php');

// 2. Validación de Token
$secret_key = "EgyysBsXsJsKNj5HGWfF";
$received_token = $_GET['token'] ?? '';

// También buscar en el header Authorization
if (empty($received_token) && isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $received_token = str_ireplace('Bearer ', '', $_SERVER['HTTP_AUTHORIZATION']);
}

if (trim($received_token) !== trim($secret_key)) {
    http_response_code(401);
    die(json_encode(['error' => 'Token inválido', 'received' => $received_token]));
}

// 3. Conexión a Base de Datos (Modo Compatible)
$conn = mysqli_connect(APP_DB_HOSTNAME, APP_DB_USERNAME, APP_DB_PASSWORD, APP_DB_NAME);
if (!$conn) {
    die(json_encode(['error' => 'Error de conexión DB']));
}
mysqli_set_charset($conn, "utf8");

$action = $_GET['action'] ?? '';
$response = ['found' => false];

switch ($action) {
    case 'get_customer_by_phone':
        $phone = preg_replace('/\D/', '', $_GET['phone'] ?? '');
        $search = (strlen($phone) > 7) ? substr($phone, -7) : $phone;
        
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.phonenumber LIKE '%$search%' OR cl.phonenumber LIKE '%$search%' 
                LIMIT 1";
        
        $res = mysqli_query($conn, $sql);
        if ($row = mysqli_fetch_assoc($res)) {
            $response = array_merge($row, ['found' => true]);
        }
        break;

    case 'get_customer_by_email':
        $email = mysqli_real_escape_string($conn, trim($_GET['email'] ?? ''));
        $sql = "SELECT c.userid as customerId, c.id as contactId, c.firstname, c.lastname, cl.company 
                FROM tblcontacts c 
                LEFT JOIN tblclients cl ON c.userid = cl.userid 
                WHERE c.email = '$email' OR c.email LIKE '%$email%'
                LIMIT 1";
        
        $res = mysqli_query($conn, $sql);
        if ($row = mysqli_fetch_assoc($res)) {
            $response = array_merge($row, ['found' => true]);
        }
        break;

    case 'get_customer_by_vat':
        $vat = mysqli_real_escape_string($conn, trim($_GET['vat'] ?? ''));
        $sql = "SELECT userid as customerId, company FROM tblclients WHERE vat LIKE '%$vat%' LIMIT 1";
        $res = mysqli_query($conn, $sql);
        if ($client = mysqli_fetch_assoc($res)) {
            $cid = $client['customerId'];
            $sql_c = "SELECT id as contactId, firstname, lastname FROM tblcontacts WHERE userid = $cid ORDER BY is_primary DESC LIMIT 1";
            $res_c = mysqli_query($conn, $sql_c);
            $contact = mysqli_fetch_assoc($res_c);
            $response = array_merge($client, $contact ? $contact : [], ['found' => true]);
        }
        break;

    case 'get_invoices':
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT id, number, total, status, hash FROM tblinvoices WHERE clientid = $cid ORDER BY id DESC LIMIT 5";
        $res = mysqli_query($conn, $sql);
        $invoices = [];
        while ($row = mysqli_fetch_assoc($res)) {
            $row['view_url'] = "https://portal.gmgroup.com.co/invoice/" . $row['id'] . "/" . $row['hash'];
            $invoices[] = $row;
        }
        $response = $invoices;
        break;

    case 'get_projects':
        $cid = intval($_GET['customer_id']);
        $sql = "SELECT id, name, status FROM tblprojects WHERE clientid = $cid LIMIT 3";
        $res = mysqli_query($conn, $sql);
        $projects = [];
        while ($row = mysqli_fetch_assoc($res)) { $projects[] = $row; }
        $response = $projects;
        break;

    default:
        $response = ['error' => 'Acción no válida'];
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
mysqli_close($conn);